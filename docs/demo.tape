# docs/demo.tape — regenerate the demo GIF with:  vhs docs/demo.tape
#
# Records a ~20s terminal session of a real run: the splash, the agent tree
# progressing, scrolling back through the transcript, and the final summary.
# (The live UI also scrolls with the mouse wheel; a terminal recorder can't
# emulate wheel events, so PgUp/PgDn drive the same viewport here.)
#
# Requires:
#   - vhs            https://github.com/charmbracelet/vhs
#   - the CLI built and linked:  npm run build && npm link
#   - a provider key set in .env (see Quickstart)

Output docs/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 700
Set Padding 18
Set Theme "Dracula"
Set TypingSpeed 55ms

# Kick off a run (autonomous so the recording never waits on a checkpoint key).
Type "elevateurskills --request 'a todo REST API' --auto"
Sleep 500ms
Enter

# Splash, then the pipeline starts and the agent tree fills in.
Sleep 6s

# Scroll back up through the transcript — the viewport freezes and shows the
# "▼ N new lines" indicator — then End to jump down and re-follow.
PageUp
Sleep 1500ms
PageUp
Sleep 1500ms
End
Sleep 2s

# Let more stages land, then linger on the final frame.
Sleep 8s
