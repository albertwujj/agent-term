# Auto-hide for idle windows

This page sets the UX auto-hide delivers; `src/window-cap.js` and `src/input-clock.js` answer to it, and `test/e2e/auto-hide.mjs` checks it in the running app.

Every session is its own window, and a working day leaves several open that you are not using: a fix waiting to be validated, an investigation waiting on a reply. Each is a taskbar button or Dock tile to scan past and a window to type into by mistake. Closing one used to clear the clutter and cost the session. Auto-hide takes a window you have stopped using out of view, and closing a window does the same at once; either way the session keeps running and comes back instantly.

## Goals

1. **Fewer wrong targets.** Only the sessions you are using are on screen, in the taskbar or Dock, and in Cmd/Alt+Tab. A hidden window cannot take focus or keystrokes.
2. **Out of view, still at hand.** A hidden session comes back instantly and exactly as it was: scrollback, viewer band, the draft at the prompt, the agent mid-conversation.
3. **Time away changes nothing.** Leaving the desk, sleep, a locked screen, or an afternoon in other apps hides no window. You return to the windows you left.
4. **Nothing moves on its own.** The taskbar and Dock rearrange when you open a window, a change you are already making, and otherwise only to bring back finished work (goal 5). The window you are using and one whose agent is working stay.
5. **Finished work surfaces.** A hidden session whose agent finishes a turn comes back into view.
6. **Closing puts a session away; exit ends it.** Closing a session's window hides it at once, whatever its agent is doing. A session ends when you stop its agent and type `exit`, the one deliberate act that means done.
7. **Bounded cost.** A hidden session costs what a visible one does, so a fixed number of live sessions holds the total to what that many open windows cost today.

## The clock

Idleness is measured on a clock that advances only with your input in AgentTerm: a minute counts when you typed, clicked, or scrolled in an AgentTerm window during it. Away, asleep, locked, or in other apps, the clock stands still (goal 3).

Agent activity leaves the clock alone. Agents run while you are away, and a clock they advanced would hide everything overnight.

A window's own timer restarts when:

- you focus it or give it input;
- its agent finishes a turn. An agent that finishes while you are away leaves its window a full interval once you return.

A window is stale after about 60 minutes of this clock without either, and hides at the next opening (below). The number is a starting point, tuned by use.

## When a window hides

Stale windows hide when you open a window: a new one, or a hidden one brought back from the picker. The number of windows only grows at that moment, and the taskbar and Dock are already changing by your hand, with your attention on the new window. Between openings nothing hides, so the set of windows stays the one you know.

These windows stay:

- the focused window;
- a window whose agent is working, through the grace period after it stops.

Closing a session's window hides it at once, with none of these exceptions: the close is your hand. A window with no session, such as a picker nobody used, has nothing to come back as, so it closes. Either way, closing the last visible window opens a fresh one on the picker, as closing the last window always has; typing `exit` is the way out without one.

Hidden means gone from every surface a click or keystroke could reach: the screen, the taskbar or Dock, and Cmd/Alt+Tab.

## Coming back

- **From the picker, instantly.** The picker lists hidden sessions as hidden; choosing one brings its window back in front. The window the picker opened in closes, since it was opened only to find that session.
- **From the shortcut, pressed twice.** Cmd/Ctrl+Shift+N opens the picker; pressed again with the picker in front, it brings back the hidden session used most recently in the picker's place, as if chosen from the list. With nothing hidden, the picker says so and stays.
- **On its own, when its agent finishes a turn.** A hidden window takes no prompts, so any turn it runs was started without you: a job-watch nudge, a scheduled wakeup, a background task ending. The window returns to the taskbar or Dock without taking focus, with its timer restarted. It returns at the turn's end, when there is a result to read; at the start there is nothing to see yet.

## Cost

Hidden sessions stay alive, including every closed one. At most 8 sessions stay alive, hidden and visible together: the most you would want as windows if none were hidden. Past that, the hidden session whose timer restarted longest ago closes: the same timer that hid it, with wall-clock time breaking ties among restarts while you were away. Visible windows are yours, so if you open more than 8 and use them, nothing closes until some hide. A closed session resumes through its CLI, as any closed session does.

The limit is a constant. Screen space and attention set it, and neither grows with RAM; a machine that runs 8 windows today already pays for 8 live sessions. No age limit applies: a session can wait days on a reply, and a wall-clock limit would end every hidden session overnight (goal 3).

## To settle by prototype

- **Full-screen sessions on macOS**, which stay for now. A full-screen window has to leave full screen to hide, which may switch you to its Space. If it does, full-screen sessions keep their Space and hide only from the Dock and Cmd+Tab.
- **The interval.**
- **Minimize as hide-now**, for a window you want out of view before the clock gets to it.

## Future considerations

Optional, for if the constant proves wrong in use.

- **A lower limit on small machines.** An 8 GB Mac already runs deep in swap with 5 windows; if hidden sessions bring swap stalls to the visible ones, scale the limit down by RAM.
- **A memory emergency brake.** Close one hidden session per critical-memory signal, with a pause between, so a lagging reading cannot close them all. The readings are indirect: macOS reports free memory near zero on any busy machine and has a pressure level whose warning state is normal on 8 GB, and on Windows the CLI's memory sits in the WSL VM and returns to Windows late. So they can only catch emergencies.
- **Cheaper hidden sessions.** A small host process could own each session's terminal, letting Electron exit while the CLI stays alive. A hidden session would then cost its CLI plus about 15–40 MB instead of about 0.6 GB, and come back with a fresh window on the current checkout and a replayed screen, losing only window-only state such as an open viewer band.
