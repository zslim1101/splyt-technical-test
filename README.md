# Splyt Technical Test - Driver Location Service

A small service that ingests location webhooks from Splyt and exposes a realtime subscription endpoint per driver.

## Tech Stack

- **[Devtunnel](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)** - Tool to expose local services to the public
- **[Fastify](https://fastify.io/)** - Fast, low overhead web framework for Node.js
- **[Socket.IO](https://socket.io/)** - Real-time bidirectional event-based communication, this is the main idea to solve real-time updates, since RESTFUL GET endpoints are not accepted in this task (this automatically eliminates the usage of HTTP-Polling )
- **[Redis](https://redis.io/)** - In-memory data store for caching events and subscriber configs, the Ordered Set data structure allows for efficient range queries
- **[Day.js](https://day.js.org/)** - Lightweight date manipulation library

## Prerequisites

Before running this project, ensure you have the following installed:

- **[Node.js](https://nodejs.org/)** (v24.12.0 in use)
- **[Yarn](https://yarnpkg.com/)**
- **[Redis](https://redis.io/download)** server running locally on default port `6379`, installed via Memurai on Windows, for macOS or Linux, just use `homebrew`

## Getting Started

### 1. Install Dependencies

```bash
yarn install
```

### 2. Start Redis Server

Make sure your Redis server is running. On Windows, you can use [WSL](https://docs.microsoft.com/en-us/windows/wsl/install) or [Memurai](https://www.memurai.com/).

```bash
# On Linux/macOS
homebrew install redis
homebrew services start redis
```

### 3. Run the Development Server

```bash
yarn dev
```

The server will start on `http://localhost:8080`.

### 4. Run devtunnel locally to expose the service to the public, acquire the public_url and register it with Splyt's mock webhooks

```bash
devtunnel login -g #-g flag is For GitHub logins
devtunnel host -p {PORT} --allow-anonymous
```

## API Reference

### `POST /event`

Ingests a driver location event from Splyt's webhook.

**Request Body:**

```json
{
  "event": {
    "name": "driver_location_update",
    "time": "2024-01-19T12:00:00Z"
  },
  "data": {
    "driver_id": "driver_001",
    "latitude": 51.5074,
    "longitude": -0.1278,
    "timestamp": "2024-01-19T12:00:00Z"
  }
}
```

**Response:**

- `200 OK` - Event processed successfully
- `500 Internal Server Error` - Server error

### WebSocket Subscription

Clients can subscribe to real-time driver location updates via Socket.IO.

**Connection:**

```typescript
const socket = io("http://localhost:8080", {
  path: "/subscribe",
});
```

**Subscribe to a Driver:**

```typescript
socket.emit("subscribe", {
  driver_id: "driver_001",
  since: "2024-01-01T00:00:00Z", // Receive events since this timestamp
});
```

**Receive Location Updates:**

```typescript
socket.on("driver_location", (data) => {
  console.log("Driver location:", data);
  // data: [{ latitude, longitude, timestamp }, ...]
});
```

**Location Update response body:**

Individual location update events are sent as objects, containing the latitude, longitude, and timestamp.

```json
{
  "latitude": 51.5074,
  "longitude": -0.1278,
  "timestamp": "2024-01-19T12:00:00Z"
}
```

Note: Historical events are returned together as an array of the above objects, this is in favor of avoiding event flooding by “since” parameter values that are very far back in the past, tradeoff being client would need to know beforehand for proper handling

### Data Flow

1. **Webhook Ingestion**: Splyt sends driver location updates to `POST /event`
2. **Event Storage**: Events are stored in Redis sorted sets keyed by `{driver_id}_events`
3. **Subscriber Management**: Client socket IDs are stored in `{driver_id}_subs` sorted sets
4. **Real-time Broadcast**: When a new event arrives, all valid subscribers receive the update

### Redis Sorted Set Usage

This solution uses Redis **Sorted Sets** (ZSET) to efficiently store and query time-series data. A sorted set is a collection of unique members, each associated with a numeric **score**. Members are automatically sorted ascendingly by score. With that in mind, it is a perfect chance to use timestamps (in milliseconds) as the score, and the location data OR subscriber config data as the member.

#### Why Sorted Sets?

| Feature                             | Benefit                                                          |
| ----------------------------------- | ---------------------------------------------------------------- |
| **Automatic sorting by score**      | Events are always ordered by timestamp (this value is passed in) |
| **Range queries (`ZRANGEBYSCORE`)** | Efficiently fetch events within a time window                    |
| **Unique members**                  | No duplicate events with the same data                           |

---

#### `POST /event` — Storing Events

When a webhook arrives, the event is stored using `ZADD`:

```typescript
await redis.zadd(`${driver_id}_events`, timestamp, JSON.stringify(rest));
```

**How it works:**

```
ZADD driver_001_events 1705665600000 '{"latitude":51.5074,"longitude":-0.1278,"timestamp":"2024-01-19T12:00:00Z"}'
```

| Argument   | Value               | Purpose                                                   |
| ---------- | ------------------- | --------------------------------------------------------- |
| **Key**    | `driver_001_events` | Unique sorted set per driver                              |
| **Score**  | `1705665600000`     | Unix timestamp in milliseconds (from `dayjs().valueOf()`) |
| **Member** | `{"latitude":...}`  | JSON-serialized location data                             |

**Result:** Events are stored sorted by time. Newer events have higher scores.

```
driver_001_events:
┌───────────────────┬──────────────────────────────────────────┐
│ Score (timestamp) │ Member (event data)                      │
├───────────────────┼──────────────────────────────────────────┤
│ 1705665600000     │ {"latitude":51.5074,"longitude":-0.1278} │
│ 1705665660000     │ {"latitude":51.5080,"longitude":-0.1280} │
│ 1705665720000     │ {"latitude":51.5085,"longitude":-0.1282} │
└───────────────────┴──────────────────────────────────────────┘
```

---

#### `socket.on("subscribe")` — Fetching Historical Events

When a client subscribes with a `since` timestamp, the server uses `ZRANGEBYSCORE` to fetch all events in the time range:

```typescript
const events = await redis.zrangebyscore(
  `${driver_id}_events`,
  sinceTs, // minimum score (client's "since" timestamp)
  currTs, // maximum score (current time)
);
```

**How it works:**

```
ZRANGEBYSCORE driver_001_events 1705665600000 1705752000000
```

| Argument | Value               | Purpose                            |
| -------- | ------------------- | ---------------------------------- |
| **Key**  | `driver_001_events` | The driver's event sorted set      |
| **Min**  | `1705665600000`     | Start of range (`since` timestamp) |
| **Max**  | `1705752000000`     | End of range (current time)        |

**Result:** Returns all events where `min <= score <= max`, already sorted by time.
**Note:** This handles gracefully when the "since" timestamp is possibly later than the current time, as it will just return an empty array.

---

#### Subscriber Management with Sorted Sets

Subscribers are also stored in a sorted set, with the **socket ID** as the member and the **`since` timestamp** as the score:

```typescript
await redis.zadd(`${driver_id}_subs`, sinceTs, socket.id);
```

This allows the `POST /event` handler to efficiently find all subscribers who should receive the new event:

```typescript
const validSubs = await redis.zrangebyscore(
  `${driver_id}_subs`,
  0, // minimum score
  currTs, // maximum score (current time)
);
```

**Why this works:** A subscriber with `since: "2024-01-01T00:00:00Z"` should receive all events from that point onward. By storing the `since` timestamp as the score, we can query for all subscribers whose `since` is less than or equal to the current time (i.e., they want events that include "now").

```
driver_001_subs:
┌───────────────────┬────────────────────────┐
│ Score (sinceTs)   │ Member (socket.id)     │
├───────────────────┼────────────────────────┤
│ 1704067200000     │ abc123-socket-id       │
│ 1705665600000     │ def456-socket-id       │
└───────────────────┴────────────────────────┘
```

## Test Clients

The `test-client-browser/` directory contains HTML test clients for debugging:

- `test-client-browser-driver-1.html` - Subscribes to `driver_001`
- `test-client-browser-driver-2.html` - Subscribes to `driver_002`

Open these files in a browser to test real-time subscriptions.

## Project Structure

```
splyt-technical-test/
├── src/
│   └── server.ts          # Main server application
├── test-client-browser/
│   ├── test-client-browser-driver-1.html
│   └── test-client-browser-driver-2.html
├── dist/                  # Compiled JavaScript output
├── package.json
├── tsconfig.json
└── README.md
```

## Scripts

| Script       | Description                                    |
| ------------ | ---------------------------------------------- |
| `yarn dev`   | Start development server with hot-reload (tsx) |
| `yarn build` | Compile TypeScript to JavaScript               |
| `yarn start` | Run the compiled production server             |
