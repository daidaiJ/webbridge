// Command webbridge-mcp is the Go MCP front end for Browser Bridge. It speaks
// MCP over stdio, starts the shared daemon on demand, and leaves all
// browser-resident work to the extension and page scripts.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/daidaiJ/webbridge/internal/app"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	instance, err := app.New()
	if err != nil {
		fmt.Fprintf(os.Stderr, "webbridge: %v\n", err)
		os.Exit(1)
	}
	if err := instance.Serve(ctx); err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		fmt.Fprintf(os.Stderr, "webbridge: %v\n", err)
		os.Exit(1)
	}
}
