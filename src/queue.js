import { Queue } from 'bullmq';
import Redis from 'ioredis';

// Connect to Redis using your connection string
const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

export const emailQueue = new Queue('email-queue', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: {
      count: 100,
      age: 24 * 3600
    }
  }
});

console.log('✅ Email queue connected to Redis');
