# Security policy

## Reporting a vulnerability

**Don't open a public issue.** Report it privately through GitHub's private vulnerability reporting: the **Security** tab, then **Report a vulnerability**. Include:

- the affected version or commit
- steps to reproduce
- the impact you expect

You should get a reply within a week.

## Scope

These are especially relevant:

- **Path traversal or arbitrary file writes** from collection data or archives: archive entries, patch paths, bundled files, profile names.
- **API key leaks**: logs, URLs, non-Nexus hosts, or plaintext on disk.
- **Escaping the sandbox**: the renderer or the built-in Nexus window reaching IPC, Node.js or `shell.openExternal` without the allowlist.
- **Spoofed nxm:// links** that install files other than the ones the collection pins.
