import { Sequelize, DataTypes } from 'sequelize';

// Initialize Sequelize connection
const sequelize = new Sequelize(
  process.env.DB_NAME || 'email_scheduler',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,  // Add port support
    dialect: 'mysql',
    logging: false,
    dialectOptions: {
      ssl: process.env.NODE_ENV === 'production' ? {
        require: true,
        rejectUnauthorized: false  // For cloud databases
      } : false
    },
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    }
  }
);

// Define EmailLog model
const EmailLog = sequelize.define('EmailLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
    allowNull: false
  },
  recipient: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      isEmail: true
    }
  },
  subject: {
    type: DataTypes.STRING,
    allowNull: false
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  senderId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  scheduledAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'SENT', 'FAILED', 'THROTTLED'),
    defaultValue: 'PENDING',
    allowNull: false
  },
  delayBetweenEmails: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
    comment: 'Delay in seconds between sending emails'
  },
  hourlyLimit: {
    type: DataTypes.INTEGER,
    defaultValue: 10,
    allowNull: false,
    comment: 'Maximum emails per hour for this sender'
  }
}, {
  tableName: 'email_logs',
  timestamps: true
});

// Sync database (create tables if they don't exist)
const syncDatabase = async () => {
  try {
    await sequelize.authenticate();
    console.log('Database connection established successfully.');
    await sequelize.sync({ alter: true });
    console.log('Database models synchronized.');
  } catch (error) {
    console.error('Unable to connect to the database:', error);
    throw error;
  }
};

export {
  sequelize,
  EmailLog,
  syncDatabase
};
