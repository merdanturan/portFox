# Record the README demo GIF:  npm run demo
# Requires vhs: https://github.com/charmbracelet/vhs
Output assets/demo.gif

Set FontSize 18
Set Width 900
Set Height 640
Set Padding 24
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

# Start a throwaway server on 3000 without showing the setup in the GIF.
Hide
Type "export PS1='$ '; export PROMPT='$ '"
Enter
Sleep 300ms
Type "alias portfox='node bin/portfox.js'"
Enter
Sleep 300ms
Type "node scripts/demo-server.mjs 3000 & disown"
Enter
Sleep 1s
Type "clear"
Enter
Sleep 300ms
Show

Type "portfox 3000"
Enter
Sleep 1500ms

# Move down to "Find available port" with vim keys.
Type "jj"
Sleep 600ms
Enter
Sleep 1500ms
Type "x"
Sleep 800ms

# Back at the menu: stop the process and confirm.
Enter
Sleep 500ms
Type "y"
Sleep 1500ms

# Show that the port is free again.
Type "portfox 3000"
Enter
Sleep 1500ms
