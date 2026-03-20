# macOS launchd Setup

To run the proxies as macOS services:

```bash
# Edit the plist files and replace /PATH/TO with your actual paths
# Also set OPENCLAW_WORKSPACE_DIR and LOCAL_FILE_VIEWER_BASE_URL if you want signed local-file links to work
cp com.openwebui.codex-proxy.plist ~/Library/LaunchAgents/
cp com.openwebui.claude-proxy.plist ~/Library/LaunchAgents/
cp com.openwebui.backup-cleanup.plist ~/Library/LaunchAgents/

launchctl load ~/Library/LaunchAgents/com.openwebui.codex-proxy.plist
launchctl load ~/Library/LaunchAgents/com.openwebui.claude-proxy.plist
launchctl load ~/Library/LaunchAgents/com.openwebui.backup-cleanup.plist
```
