# Teen Patti Online

Multiplayer Teen Patti in the browser. One table for up to 60 players, a 5-deck shoe (260 cards), virtual chips, and three exchange options.

## Features
- Home page: enter your name and press Start. Refreshing the page puts you back in your seat.
- First player to join is the **host** (Start round, End round, settings, remove players, hand over host).
- Betting: boot, Blind (1x stake) / Chaal (2x stake when seen), Raise (doubles the stake), Pack, Show (when 2 players remain).
- Exchange (limits and fee set by host; default 1 per player per round, fee = current stake):
  1. Swap 1 card with the shoe (on your turn)
  2. Swap your whole hand with the shoe (on your turn)
  3. Offer one card to another player; they pick which card to give back, or decline
- 5 decks shuffled every round; discards are reshuffled if the shoe runs out.
- Turn timer (auto-pack on timeout), leaderboard, activity log, rebuy, sit out.

## Hand rankings
Trail > Pure Sequence > Sequence > Colour > Pair > High Card.
A-K-Q is the top sequence, A-2-3 the lowest; K-A-2 is not a sequence.
Ties: higher cards, then suits (Spades > Hearts > Diamonds > Clubs). Identical hands (possible with 5 decks): the player who asked for the Show loses.

## Run locally
```
npm install
npm start          # http://localhost:3000
```

## Deploy free on Render (gets you a public link)
1. Push this folder to a GitHub repository.
2. On render.com: New > Blueprint (or Web Service) > pick the repo. `render.yaml` sets everything up.
3. Render gives a link like `https://teen-patti-xxxx.onrender.com`. Share it with players.

Note: game state is kept in memory, so restarting the server resets the table. On Render's free plan the server sleeps after 15 minutes with nobody connected; the first visit then takes about a minute to wake up.

Railway, Fly.io or any Node host works too: `npm install && npm start`, port comes from `PORT`.
