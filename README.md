# claude-hours

Detailed Claude Code time tracking tool!

## Install

Works on macOS and Linux (on Windows, run Claude Code inside WSL). You need
Claude Code, `curl` and `python3`.

```sh
curl -fsSL https://claude-hours.k.hackclub.dev/install.sh | sh
```

(you might need to reopen Claude Code for time tracking to start working)

## Connect it to the server

1. Log in at [claude-hours.k.hackclub.dev](https://claude-hours.k.hackclub.dev)
   with your Hack Club Auth account.
2. In Settings, under Connect Claude Code, make a login command.
3. Paste it into Claude Code. It looks like
   `/time-track login https://claude-hours.k.hackclub.dev <code>` and works
   once (expires in 10 minutes).

## Usage

| Command                             | What it does                                                          |
| ----------------------------------- | --------------------------------------------------------------------- |
| `/time-track status`                | who you're logged in as, the last sync, and anything stuck or failing |
| `/time-track stats`                 | today, the last 7 days (with your top projects) and all time          |
| `/time-track statusline`            | shows today's time on a line under the prompt, or hides it again      |
| `/time-track ignore`                | stops logging the repo you're in; run it again to start again         |
| `/time-track backfill [send]`       | finds sessions from before it in your transcripts; `send` uploads     |
| `/time-track update`                | gets the server's newest mod (a toast tells you when there is one)    |
| `/time-track login <server> [code]` | connects this computer; without a code it gives you a link to approve |
| `/time-track logout`                | disconnects this computer, here and on the server                     |

## Privacy

- Prompts are logged as counts (words, characters, typing time), never their
  text, and file contents are never logged at all.
- Local paths are: the folder each session runs in and the files tools touch.
- Nothing leaves your computer until you log in to a server.
- `/time-track backfill` reads Claude Code's transcripts on your computer and
  keeps the same counts from them, never their text. Nothing it finds goes up
  until you run `/time-track backfill send`.
- `/time-track ignore` leaves a whole repo out, and
  `~/.claude/analytics/config.json` can leave out single files
  ([how](docs/how-it-works.md#choosing-which-files-get-logged)).
- The server's settings page lists your connected computers, revokes them, and
  takes requests to delete everything you've sent. Once an admin approves one,
  your account and all of it are gone for good.

## Uninstall

```sh
curl -fsSL https://claude-hours.k.hackclub.dev/install.sh | sh -s uninstall           # keeps ~/.claude/analytics
curl -fsSL https://claude-hours.k.hackclub.dev/install.sh | sh -s uninstall --purge   # deletes it too
```

## Docs

- [How it works](docs/how-it-works.md): what gets logged, how time is
  counted, the sync protocol, and running or deploying it yourself
- [mod/TODO.md](mod/TODO.md): every field the mod logs, and its known limits

## License

[AGPL-3.0](LICENSE)
