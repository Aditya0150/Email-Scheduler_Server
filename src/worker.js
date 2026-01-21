import 'dotenv/config';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import nodemailer from 'nodemailer';
import { EmailLog } from './models.js';

const MIN_DELAY_BETWEEN_EMAILS = 2;

// Connect to Redis - same as queue.js
const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

// Create transporter for sending emails
const transporter = nodemailer.createTransport({
  host: 'smtp.ethereal.email',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER || 'your-ethereal-user',
    pass: process.env.EMAIL_PASS || 'your-ethereal-pass'
  }
});

// Check rate limit with user-defined hourly limit
const checkRateLimit = async (senderId, hourlyLimit) => {
  const now = new Date();
  const currentHour = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}`;
  const rateLimitKey = `rate-limit:${senderId}:${currentHour}`;
  
  const currentCount = await redisConnection.get(rateLimitKey);
  const count = currentCount ? parseInt(currentCount) : 0;
  
  return {
    allowed: count < hourlyLimit,
    currentCount: count,
    limit: hourlyLimit,
    rateLimitKey,
    currentHour
  };
};

// Increment rate limit counter
const incrementRateLimit = async (rateLimitKey) => {
  const count = await redisConnection.incr(rateLimitKey);
  if (count === 1) {
    await redisConnection.expire(rateLimitKey, 3600);
  }
  return count;
};

// Calculate delay to next hour
const getDelayToNextHour = () => {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1);
  nextHour.setMinutes(0);
  nextHour.setSeconds(0);
  nextHour.setMilliseconds(0);
  return nextHour.getTime() - now.getTime();
};

// Send email function
const sendEmail = async (recipient, subject, body) => {
  const transport = await createTransporter();
  
  const info = await transport.sendMail({
    from: process.env.SMTP_FROM || '"Email Scheduler" <scheduler@example.com>',
    to: recipient,
    subject: subject,
    text: body,
    html: `<p>${body}</p>`
  });
  
  console.log('📧 Message sent: %s', info.messageId);
  console.log('🔗 Preview URL: %s', nodemailer.getTestMessageUrl(info));
  
  return info;
};

// Create BullMQ Worker
const worker = new Worker(
  'email-queue',
  async (job) => {
    // Get user-defined settings from job data
    const { 
      emailLogId, 
      recipient, 
      subject, 
      body, 
      senderId,
      delayBetweenEmails = MIN_DELAY_BETWEEN_EMAILS,
      hourlyLimit
    } = job.data;
    
    // Ensure minimum delay
    const actualDelay = Math.max(delayBetweenEmails, MIN_DELAY_BETWEEN_EMAILS);
    
    console.log(`\n📧 Processing job ${job.id} for email log ${emailLogId}`);
    console.log(`⚙️  User Settings: delay=${actualDelay}s, hourlyLimit=${hourlyLimit}/hour`);
    
    try {
      // Check idempotency
      const emailLog = await EmailLog.findByPk(emailLogId);
      
      if (!emailLog) {
        throw new Error(`EmailLog with id ${emailLogId} not found`);
      }
      
      if (emailLog.status === 'SENT') {
        console.log(`✓ Email ${emailLogId} already sent. Skipping.`);
        return { status: 'already_sent', emailLogId };
      }
      
      // Check rate limit using user-defined hourly limit
      const rateLimit = await checkRateLimit(senderId, hourlyLimit);
      
      if (!rateLimit.allowed) {
        console.log(`⏸️  Rate limit exceeded for sender ${senderId}`);
        console.log(`   Current: ${rateLimit.currentCount}/${rateLimit.limit} emails this hour`);
        
        await emailLog.update({ status: 'THROTTLED' });
        
        const delay = getDelayToNextHour();
        
        // Reschedule with same settings
        await emailQueue.add(
          'send-email',
          {
            ...job.data,
            delayBetweenEmails: actualDelay,
            hourlyLimit
          },
          { 
            delay,
            jobId: `${emailLogId}-retry-${Date.now()}`
          }
        );
        
        const delayMinutes = Math.round(delay / 1000 / 60);
        console.log(`⏭️  Email ${emailLogId} rescheduled to next hour (~${delayMinutes} min)`);
        
        return { 
          status: 'throttled', 
          emailLogId, 
          rescheduledDelay: delay 
        };
      }
      
      // Send email
      await sendEmail(recipient, subject, body);
      
      // ⭐ APPLY USER-DEFINED DELAY (minimum 2 seconds)
      const delayMs = actualDelay * 1000;
      console.log(`⏳ Applying ${actualDelay}s delay before next email can process...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
      // Increment rate limit counter
      const newCount = await incrementRateLimit(rateLimit.rateLimitKey);
      console.log(`📊 Rate limit: ${newCount}/${rateLimit.limit} emails sent this hour`);
      
      // Update EmailLog status to SENT
      await emailLog.update({ status: 'SENT' });
      
      console.log(`✅ Email ${emailLogId} sent successfully to ${recipient}`);
      
      return { 
        status: 'sent', 
        emailLogId,
        recipient 
      };
      
    } catch (error) {
      console.error(`❌ Error processing job ${job.id}:`, error.message);
      
      try {
        await EmailLog.update(
          { status: 'FAILED' },
          { where: { id: emailLogId } }
        );
      } catch (updateError) {
        console.error('Error updating EmailLog status to FAILED:', updateError);
      }
      
      throw error;
    }
  },
  {
    connection, // Use the Redis connection
    concurrency: 3,
    limiter: {
      max: 5,
      duration: 10000
    }
  }
);

// Worker event listeners
worker.on('completed', (job, result) => {
  console.log(`✓ Job ${job.id} completed:`, result.status);
});

worker.on('failed', (job, err) => {
  console.error(`✗ Job ${job?.id} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('⚠️  Worker error:', err);
});

console.log('\n📬 Email Queue Worker Started');
console.log('⚙️  Concurrency: 3 workers');
console.log('⚙️  Minimum delay between emails: 2 seconds');
console.log('⚙️  User-defined delays enabled\n');

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, closing worker...');
  await worker.close();
  await redisConnection.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT received, closing worker...');
  await worker.close();
  await redisConnection.quit();
  process.exit(0);
});

export default worker;
