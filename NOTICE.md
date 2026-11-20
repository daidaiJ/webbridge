# Third-party components

This repository contains the MCP adapter, agent skill, popup UI, build tooling,
and tests. It does not include the upstream browser bridge daemon or the
upstream extension source bundle.

Release bundles include a built, loadable extension for convenience. That build
contains code from the upstream Browser Bridge distribution and remains subject
to the upstream project's terms. The MIT license in `LICENSE` covers the code in
this repository, not the upstream runtime.

The daemon and extension are separate components. This project talks to the
daemon over its documented loopback HTTP API and never bundles the daemon
binary.
