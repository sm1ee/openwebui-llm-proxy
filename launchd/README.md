# macOS launchd Setup

To run the proxies as macOS services:

```bash
# Edit the plist files and replace /PATH/TO with your actual paths
cp com.openwebui.codex-proxy.plist ~/Library/LaunchAgents/
cp com.openwebui.claude-proxy.plist ~/Library/LaunchAgents/
cp com.openwebui.backup-cleanup.plist ~/Library/LaunchAgents/

launchctl load ~/Library/LaunchAgents/com.openwebui.codex-proxy.plist
launchctl load ~/Library/LaunchAgents/com.openwebui.claude-proxy.plist
launchctl load ~/Library/LaunchAgents/com.openwebui.backup-cleanup.plist
```
