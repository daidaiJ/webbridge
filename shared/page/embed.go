// Package page embeds the self-contained scripts that run inside the browser.
// Node loads the same .fn.js files through the small wrappers in this package;
// the Go MCP server sends them through the daemon's evaluate action.
package page

import _ "embed"

//go:embed reader.fn.js
var Reader string

//go:embed extract.fn.js
var Extract string

//go:embed console.fn.js
var Console string

//go:embed capture.fn.js
var Capture string
