# Strategietage Voting (Node + Redis)

Self-hosted point voting for the EB (Nikki, Tom, Tim). Everyone has 9 points, freely distributable
(all 9 on one topic is fine). Votes are stored in Redis and stay hidden from the others until
everyone has submitted and someone clicks "Ergebnisse aufdecken".

## Start

    docker compose up -d --build
    # open http://<host>:3000

Each person opens the page, picks their name (stored in the browser) and votes.
Votes are auto-saved to Redis on every click, so a reload or crash loses nothing.

## Flow

1. **Voting (afternoon, day 1):** everyone distributes their 9 points and clicks "Abstimmung abgeben".
   You can withdraw a submission until the results are revealed.
2. **Reveal:** once all three have submitted, anyone can reveal. ("Trotzdem aufdecken" forces it.)
   The server only sends other people's votes after the reveal, so there is no peeking.
3. **Results page:**
   - **Nachmittag: Kurz-Pitch** – topics with only one voter, 5 min each (the voter pitches it).
   - **Tag 2: Deep Dive** – topics with at least 2 voters, ranked by points. The 360 minutes
     are split proportionally to points in 5-minute steps (sums exactly to 360).
   - Topics without votes are listed collapsed. CSV export and print/PDF are available.
   - Time budget, pitch length and the "2 voters" threshold can be changed on the page.

## Configuration (docker-compose.yml)

| Variable | Default | Meaning |
|---|---|---|
| `PARTICIPANTS` | `Nikki,Tom,Tim` | Who may vote |
| `POINTS_PER_PERSON` | `9` | Point budget |
| `DAY2_MINUTES` | `360` | Deep-dive time (6 h) |
| `PITCH_MINUTES` | `5` | Pitch time per single-voter topic |
| `MIN_VOTERS` | `2` | Voters needed for a deep-dive slot |
| `ACCESS_PIN` | empty | Optional shared PIN asked when opening the page |
| `REDIS_URL` | `redis://redis:6379` | Without it the app falls back to an in-memory store (dev only) |

## Topics and categories

Edit `topics.json` (categories -> topics with `id`, `title`, `context`) and restart:
`docker compose restart app`. Keep ids unique and stable once voting has started.

## Notes

- There is no real authentication: a name is picked in the browser, so anyone who can reach the
  page could vote as someone else. Run it on an internal network/VPN; `ACCESS_PIN` adds a light barrier.
- Redis is not published to the host and persists with AOF in the `redis-data` volume.
- "Alle Stimmen zurücksetzen" on the results page wipes votes (asks twice). To start over from the shell:
  `docker compose exec redis redis-cli --scan --pattern 'strategie2026:*' | xargs docker compose exec -T redis redis-cli del`
- The page polls the server every 3 s, so status chips and the reveal update live.
