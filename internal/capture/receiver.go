package capture

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/daidaiJ/webbridge/internal/activity"
	"github.com/daidaiJ/webbridge/internal/handoff"
)

const maxReceiverBody = 4 * 1024 * 1024

var extensionOrigin = regexp.MustCompile(`(?i)^(chrome|moz|safari-web)-extension://`)

// Receiver is the loopback HTTP and WebSocket endpoint the extension uses for
// context-menu captures, handoff prompts, and popup activity.
type Receiver struct {
	Server    *http.Server
	Listener  net.Listener
	Host      string
	Port      int
	Dir       string
	closeOnce sync.Once
	closeHook func()
}

type wsClient struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *wsClient) send(message any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = c.conn.WriteJSON(message)
}

func (c *wsClient) ping() {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = c.conn.WriteMessage(websocket.PingMessage, nil)
}

// Start binds the receiver. A port conflict is returned to the caller so the
// MCP server can log it and keep serving tool calls.
func Start(host string, port int, dir string, handoffs *handoff.Store, actions *activity.Log) (*Receiver, error) {
	if host == "" {
		host = strings.TrimSpace(os.Getenv("WEBBRIDGE_CAPTURE_HOST"))
	}
	if host == "" {
		host = "127.0.0.1"
	}
	if dir == "" {
		dir = Root("")
	}

	receiver := &Receiver{Host: host, Port: port, Dir: dir}
	clients := make(map[*wsClient]bool)
	var clientsMu sync.Mutex

	upgrader := websocket.Upgrader{
		CheckOrigin: func(request *http.Request) bool {
			origin := request.Header.Get("Origin")
			return origin == "" || extensionOrigin.MatchString(origin)
		},
	}

	unsubscribe := handoffs.Subscribe(func(pending []handoff.Entry) {
		clientsMu.Lock()
		current := make([]*wsClient, 0, len(clients))
		for client := range clients {
			current = append(current, client)
		}
		clientsMu.Unlock()
		message := map[string]any{"type": "handoff", "pending": pending}
		for _, client := range current {
			client.send(message)
		}
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(response http.ResponseWriter, request *http.Request) {
		receiverHeaders(response, request)
		path := request.URL.Path

		if request.Method == http.MethodOptions {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		if request.Method == http.MethodGet && path == "/health" {
			writeJSON(response, http.StatusOK, map[string]any{"ok": true, "dir": dir})
			return
		}
		if request.Method == http.MethodGet && path == "/activity" {
			writeJSON(response, http.StatusOK, map[string]any{"actions": actions.List(20)})
			return
		}
		if request.Method == http.MethodGet && path == "/handoff" {
			writeJSON(response, http.StatusOK, map[string]any{"pending": handoffs.List()})
			return
		}
		if request.Method == http.MethodGet && path == "/handoff/watch" {
			waitMs := 20000
			if raw := request.URL.Query().Get("wait_ms"); raw != "" {
				if value, err := strconv.Atoi(raw); err == nil {
					if value < 0 {
						value = 0
					}
					if value > 30000 {
						value = 30000
					}
					waitMs = value
				}
			}
			pending := handoffs.Wait(time.Duration(waitMs) * time.Millisecond)
			writeJSON(response, http.StatusOK, map[string]any{"pending": pending})
			return
		}
		if request.Method == http.MethodPost && strings.HasPrefix(path, "/handoff/") && strings.HasSuffix(path, "/resume") {
			encoded := strings.TrimSuffix(strings.TrimPrefix(path, "/handoff/"), "/resume")
			id := encoded
			if decoded, err := url.PathUnescape(encoded); err == nil {
				id = decoded
			}
			if handoffs.Resume(id) {
				writeJSON(response, http.StatusOK, map[string]any{"ok": true})
			} else {
				writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown handoff"})
			}
			return
		}
		if request.Method != http.MethodPost || path != "/capture" {
			writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "not found"})
			return
		}

		request.Body = http.MaxBytesReader(response, request.Body, maxReceiverBody)
		body, err := io.ReadAll(request.Body)
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "capture: body too large"})
			return
		}
		var payload struct {
			Page    map[string]any `json:"page"`
			Tags    any            `json:"tags"`
			Session any            `json:"session"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if payload.Page == nil {
			writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "page.text is required"})
			return
		}
		text, ok := payload.Page["text"].(string)
		if !ok {
			writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "page.text is required"})
			return
		}
		runes := []rune(text)
		if len(runes) > 400000 {
			payload.Page["text"] = string(runes[:400000])
		}
		if _, ok := payload.Page["source"].(string); !ok {
			payload.Page["source"] = "extension"
		}
		session, _ := payload.Session.(string)
		if session == "" {
			session = "extension"
		}
		tags := stringList(payload.Tags)
		result, err := Persist(payload.Page, dir, tags, session, "", "")
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		responsePayload := map[string]any{"ok": true}
		for key, value := range result {
			responsePayload[key] = value
		}
		writeJSON(response, http.StatusOK, responsePayload)
	})

	mux.HandleFunc("/ws", func(response http.ResponseWriter, request *http.Request) {
		conn, err := upgrader.Upgrade(response, request, nil)
		if err != nil {
			return
		}
		client := &wsClient{conn: conn}
		clientsMu.Lock()
		clients[client] = true
		clientsMu.Unlock()
		client.send(map[string]any{"type": "hello", "pending": handoffs.List()})

		go func() {
			defer func() {
				clientsMu.Lock()
				delete(clients, client)
				clientsMu.Unlock()
				_ = conn.Close()
			}()
			for {
				_, message, err := conn.ReadMessage()
				if err != nil {
					return
				}
				if strings.Contains(string(message), `"handoff"`) {
					client.send(map[string]any{"type": "handoff", "pending": handoffs.List()})
				}
			}
		}()
	})

	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		unsubscribe()
		return nil, err
	}
	receiver.Listener = listener
	if address, ok := listener.Addr().(*net.TCPAddr); ok {
		receiver.Port = address.Port
	}
	server.Handler = mux

	heartbeat := time.NewTicker(20 * time.Second)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-heartbeat.C:
				clientsMu.Lock()
				current := make([]*wsClient, 0, len(clients))
				for client := range clients {
					current = append(current, client)
				}
				clientsMu.Unlock()
				for _, client := range current {
					client.ping()
				}
			case <-done:
				return
			}
		}
	}()

	receiver.Server = server
	receiver.closeHook = func() {
		close(done)
		heartbeat.Stop()
		unsubscribe()
		clientsMu.Lock()
		for client := range clients {
			_ = client.conn.Close()
		}
		clients = map[*wsClient]bool{}
		clientsMu.Unlock()
	}
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && serveErr != http.ErrServerClosed {
			log.Printf("webbridge: capture receiver: %v", serveErr)
		}
	}()
	return receiver, nil
}

func (r *Receiver) Close() {
	if r == nil {
		return
	}
	r.closeOnce.Do(func() {
		if r.closeHook != nil {
			r.closeHook()
		}
		if r.Server != nil {
			_ = r.Server.Close()
		}
	})
}

func receiverHeaders(response http.ResponseWriter, request *http.Request) {
	origin := request.Header.Get("Origin")
	response.Header().Set("Vary", "Origin")
	if extensionOrigin.MatchString(origin) {
		response.Header().Set("Access-Control-Allow-Origin", origin)
		response.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		response.Header().Set("Access-Control-Allow-Headers", "content-type")
		response.Header().Set("Access-Control-Allow-Private-Network", "true")
	}
	response.Header().Set("Cache-Control", "no-store")
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	encoded, err := encodeJSON(value)
	if err != nil {
		_, _ = response.Write([]byte(`{"ok":false}`))
		return
	}
	_, _ = response.Write([]byte(encoded))
}
