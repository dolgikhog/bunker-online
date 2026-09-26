# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub instead:
**[Report a vulnerability](https://github.com/dolgikhog/bunker-online/security/advisories/new)**
(the repository's **Security** tab → **Report a vulnerability**).

Useful things to include:

- what an attacker can do, and what it takes (a player in the room, a spectator, anyone on the internet);
- the steps or a small script that shows it;
- the game version, if you know it.

The answer comes in the private advisory thread. Please allow a reasonable time for a fix before you talk about it
in public. Test only against a server you run yourself (`npm start`, see the README), not against the live game, and never
against other people's games.

## Scope

In scope: the game server (`server/`), the browser client (`public/`), and the deploy scripts (`deploy/`).

Examples of what counts: seeing another player's hidden cards, acting as another player or as the host, getting
around the rate and connection limits, crashing or freezing the server, running code in another player's browser.

## Supported versions

Only the latest code on `main` gets security fixes.
