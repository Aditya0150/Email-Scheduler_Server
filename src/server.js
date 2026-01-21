// backend/src/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { emailQueue } from './queue.js';
import { EmailLog, syncDatabase } from './models.js';

const app = express();
const PORT = process.env.PORT || 3000;
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:8080'],
  credentials: true
}));
app.use(express.json());

// ============= AUTH ROUTES =============

// Google OAuth Login Route
app.post('/api/auth/google', async (req, res) => {
  const { token, tokenType } = req.body;

  try {
    let user;

    if (tokenType === 'access_token') {
      console.log('Verifying access token...');
      const userInfoResponse = await axios.get(
        'https://www.googleapis.com/oauth2/v3/userinfo',
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const userInfo = userInfoResponse.data;
      user = {
        id: userInfo.sub,
        email: userInfo.email,
        name: userInfo.name,
        avatar: userInfo.picture,
        emailVerified: userInfo.email_verified
      };

    } else {
      console.log('Verifying ID token...');
      const ticket = await client.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID
      });

      const payload = ticket.getPayload();
      user = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        avatar: payload.picture,
        emailVerified: payload.email_verified
      };
    }

    const appToken = jwt.sign(
      { userId: user.id, email: user.email, name: user.name, avatar: user.avatar },
      process.env.JWT_SECRET || 'your-secret-key-change-this-in-production',
      { expiresIn: '7d' }
    );

    console.log('✅ User authenticated:', user.email);

    res.json({
      success: true,
      user: user,
      token: appToken
    });

  } catch (error) {
    console.error('❌ Error verifying Google token:', error.message);
    res.status(401).json({
      success: false,
      error: 'Invalid token',
      details: error.message
    });
  }
});

// Verify token endpoint
app.post('/api/auth/verify', (req, res) => {
  const { token } = req.body;

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'your-secret-key-change-this-in-production'
    );

    res.json({
      success: true,
      user: {
        id: decoded.userId,
        email: decoded.email,
        name: decoded.name,
        avatar: decoded.avatar
      }
    });
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token'
    });
  }
});

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(
    token,
    process.env.JWT_SECRET || 'your-secret-key-change-this-in-production',
    (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }
      req.user = user;
      next();
    }
  );
}

// Protected route example
app.get('/api/user/profile', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

// ============= EMAIL SCHEDULING ROUTES =============

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Email Scheduler API is running',
    timestamp: new Date().toISOString()
  });
});

// POST /schedule - Schedule an email (protected)
app.post('/schedule', authenticateToken, async (req, res) => {
  try {
    const { recipient, subject, body, scheduledAt, delayBetweenEmails, hourlyLimit } = req.body;
    const senderId = req.user.userId;
    
    // Validate required fields (scheduledAt is now optional)
    if (!recipient || !subject || !body) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: recipient, subject, body'
      });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(recipient)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format for recipient'
      });
    }
    
    // Handle scheduling
    let scheduledTime;
    let delay = 0; // Default to immediate send
    
    if (scheduledAt) {
      // Parse and validate scheduledAt
      scheduledTime = new Date(scheduledAt);
      if (isNaN(scheduledTime.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid scheduledAt date format'
        });
      }
      
      // Calculate delay
      const now = Date.now();
      delay = scheduledTime.getTime() - now;
      
      if (delay < 0) {
        return res.status(400).json({
          success: false,
          error: 'Scheduled time must be in the future'
        });
      }
    } else {
      // Send immediately - use current time
      scheduledTime = new Date();
    }
    
    // Save to database with user-defined settings
    const emailLog = await EmailLog.create({
      recipient,
      subject,
      body,
      senderId,
      scheduledAt: scheduledTime,
      status: 'PENDING',
      delayBetweenEmails: delayBetweenEmails || 0,
      hourlyLimit: hourlyLimit || 10
    });
    
    // Add job to BullMQ queue with delay (0 for immediate)
    const job = await emailQueue.add(
      'send-email',
      {
        emailLogId: emailLog.id,
        recipient,
        subject,
        body,
        senderId,
        delayBetweenEmails: emailLog.delayBetweenEmails,
        hourlyLimit: emailLog.hourlyLimit
      },
      {
        delay,
        jobId: emailLog.id
      }
    );
    
    const message = delay === 0 ? 'Email queued for immediate sending' : 'Email scheduled successfully';
    console.log(`${message}: ${emailLog.id}, Job ID: ${job.id}, Delay: ${delay}ms, DelayBetweenEmails: ${emailLog.delayBetweenEmails}s, HourlyLimit: ${emailLog.hourlyLimit}`);
    
    return res.status(201).json({
      success: true,
      message,
      data: {
        emailLogId: emailLog.id,
        jobId: job.id,
        recipient,
        scheduledAt: scheduledTime,
        delay,
        delayBetweenEmails: emailLog.delayBetweenEmails,
        hourlyLimit: emailLog.hourlyLimit,
        status: 'PENDING'
      }
    });
    
  } catch (error) {
    console.error('Error scheduling email:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to schedule email',
      message: error.message
    });
  }
});

// GET /emails - Get all email logs (protected, filtered by user and optional status)
app.get('/emails', authenticateToken, async (req, res) => {
  try {
    const senderId = req.user.userId;
    const { status } = req.query;
    
    const where = { senderId };
    if (status) {
      where.status = status;
    }
    
    const emails = await EmailLog.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: 100
    });
    
    return res.json({
      success: true,
      count: emails.length,
      data: emails
    });
  } catch (error) {
    console.error('Error fetching emails:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch emails',
      message: error.message
    });
  }
});

// GET /emails/:id - Get specific email log (protected)
app.get('/emails/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const senderId = req.user.userId;
    
    const emailLog = await EmailLog.findOne({
      where: { id, senderId }
    });
    
    if (!emailLog) {
      return res.status(404).json({
        success: false,
        error: 'Email log not found'
      });
    }
    
    return res.json({
      success: true,
      data: emailLog
    });
  } catch (error) {
    console.error('Error fetching email:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch email',
      message: error.message
    });
  }
});

// DELETE /emails/:id - Delete specific email log (protected)
app.delete('/emails/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const senderId = req.user.userId;
    
    const emailLog = await EmailLog.findOne({
      where: { id, senderId }
    });
    
    if (!emailLog) {
      return res.status(404).json({
        success: false,
        error: 'Email log not found'
      });
    }

    // Remove job from queue if it exists
    try {
      const job = await emailQueue.getJob(id);
      if (job) {
        await job.remove();
        console.log(`Removed job ${id} from queue`);
      }
    } catch (err) {
      console.log('Job not found in queue or already processed');
    }
    
    await emailLog.destroy();
    
    return res.json({
      success: true,
      message: 'Email deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting email:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete email',
      message: error.message
    });
  }
});

// GET /queue/stats - Get queue statistics (protected)
app.get('/queue/stats', authenticateToken, async (req, res) => {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      emailQueue.getWaitingCount(),
      emailQueue.getActiveCount(),
      emailQueue.getCompletedCount(),
      emailQueue.getFailedCount(),
      emailQueue.getDelayedCount()
    ]);
    
    return res.json({
      success: true,
      stats: {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + delayed
      }
    });
  } catch (error) {
    console.error('Error fetching queue stats:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch queue stats',
      message: error.message
    });
  }
});

// Initialize database and start server
const startServer = async () => {
  try {
    await syncDatabase();
    
    app.listen(PORT, () => {
      console.log(`\n✅ Server running on http://localhost:${PORT}`);
      console.log(`✅ Health check: http://localhost:${PORT}/health`);
      console.log(`\n📧 Email API endpoints:`);
      console.log(`  POST /schedule - Schedule a new email`);
      console.log(`  GET /emails - View all email logs`);
      console.log(`  GET /emails/:id - View specific email log`);
      console.log(`  GET /queue/stats - View queue statistics`);
      console.log(`\n🔐 Auth API endpoints:`);
      console.log(`  POST /api/auth/google - Google OAuth login`);
      console.log(`  POST /api/auth/verify - Verify JWT token`);
      console.log(`  GET /api/user/profile - Get user profile`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;