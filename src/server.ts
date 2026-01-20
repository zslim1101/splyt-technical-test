import Fastify from "fastify";
import { Type } from "typebox";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import dayjs from "dayjs";

const fastify = Fastify({ logger: true });
const io = new Server(fastify.server, {
  path: "/subscribe",
  cors: {
    origin: "*",
  },
});
const redis = new Redis();

// Event body interface for compile-time
interface EventBody {
  event: {
    name: string;
    time: string;
  };
  data: {
    driver_id: string;
    latitude: number;
    longitude: number;
    timestamp: string;
  };
}

// Event endpoint validation
const eventSchema = {
  schema: {
    body: Type.Object({
      event: Type.Object({
        name: Type.String(),
        time: Type.String(),
      }),
      data: Type.Object({
        driver_id: Type.String(),
        latitude: Type.Number(),
        longitude: Type.Number(),
        timestamp: Type.String(),
      }),
    }),
  },
};

fastify.post<{ Body: EventBody }>(
  "/event",
  eventSchema,
  async (request, reply) => {
    fastify.log.info(request.body);

    const { event, data } = request.body;
    const timestamp = dayjs(event.time).valueOf();
    const { driver_id, ...rest } = data;
    await redis.zadd(`${driver_id}_events`, timestamp, JSON.stringify(rest));

    // Emit driver location to subscribers that have "since" <= now
    const currTs = dayjs().valueOf();
    try {
      const validSubs = await redis.zrangebyscore(
        `${driver_id}_subs`,
        0,
        currTs,
      );
      for (const socketId of validSubs) {
        io.to(socketId).emit("driver_location", rest);
      }
      reply.status(200).send("OK");
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send("Internal Server Error");
    }
  },
);

// Configure socket IO
io.on("connection", (socket) => {
  socket.on(
    "subscribe",
    async ({ driver_id, since }: { driver_id: string; since: string }) => {
      const currTs = dayjs().valueOf();
      const sinceTs = dayjs(since).valueOf();
      fastify.log.info(`Client ${socket.id} subscribed to driver ${driver_id}`);
      // Store socketId -> driverId mapping for cleanup on disconnect
      await redis.set(`${socket.id}_driver_id`, driver_id);
      await redis.zadd(`${driver_id}_subs`, sinceTs, socket.id);

      // Check if any update is available right away, if none then do nothing
      const events = await redis.zrangebyscore(
        `${driver_id}_events`,
        sinceTs,
        currTs,
      );
      if (events.length > 0) {
        socket.emit(
          "driver_location",
          events.map((e) => JSON.parse(e)),
        );
      }
    },
  );

  socket.on("disconnect", async () => {
    fastify.log.info(`Client ${socket.id} disconnected`);

    const driverId = await redis.get(`${socket.id}_driver_id`);
    // Remove the socketId from subs sorted set
    await redis.zrem(`${driverId}_subs`, socket.id);
    // Remove the driverId -> socketId mapping
    await redis.del(`${socket.id}_driver_id`);
  });
});

fastify.listen({ port: 8080, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
  }
  fastify.log.info(`server listening on ${address}`);
});
