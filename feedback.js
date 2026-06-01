const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

class FeedbackManager {
  constructor() {
    this.db = null;
    this.dbPath = process.env.DATABASE_PATH || './feedback.db';
    this.initialized = false;
  }

  async initialize() {
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      
      this.createTables();
      this.initialized = true;
      console.log('✅ SQLite database initialized');
    } catch (error) {
      console.error('❌ Failed to initialize database:', error.message);
      throw error;
    }
  }

  createTables() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        discord_user TEXT,
        email TEXT,
        feedback_text TEXT NOT NULL,
        intercom_id TEXT,
        status TEXT DEFAULT 'pending',
        duplicate_count INTEGER DEFAULT 1,
        similar_ids TEXT,
        approval_date TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    this.db.exec(createTableSQL);
    console.log('✅ Feedback table ready');
  }

  async addFeedback(data) {
    const {
      discordUser,
      email,
      feedbackText,
      intercomId = '',
      duplicateCount = 1,
    } = data;

    const id = `FB-${Date.now()}`;
    const timestamp = new Date().toISOString();
    const status = 'pending';

    const stmt = this.db.prepare(`
      INSERT INTO feedback (
        id, timestamp, discord_user, email, feedback_text, 
        intercom_id, status, duplicate_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      timestamp,
      discordUser || 'Unknown',
      email,
      feedbackText,
      intercomId,
      status,
      duplicateCount
    );

    return {
      id,
      discordUser,
      email,
      feedbackText,
      intercomId,
      status,
      timestamp,
      'Duplicate Count': duplicateCount,
      ID: id,
      'Feedback Text': feedbackText,
      'Discord User': discordUser,
      Email: email,
    };
  }

  async getAllFeedback() {
    const stmt = this.db.prepare('SELECT * FROM feedback ORDER BY created_at DESC');
    const rows = stmt.all();
    
    return rows.map(row => ({
      ID: row.id,
      Timestamp: row.timestamp,
      'Discord User': row.discord_user,
      Email: row.email,
      'Feedback Text': row.feedback_text,
      'Intercom ID': row.intercom_id,
      Status: row.status,
      'Duplicate Count': row.duplicate_count,
      'Similar IDs': row.similar_ids || '',
      'Approval Date': row.approval_date || '',
      id: row.id,
      discordUser: row.discord_user,
      feedbackText: row.feedback_text,
    }));
  }

  async getFeedbackById(feedbackId) {
    const stmt = this.db.prepare('SELECT * FROM feedback WHERE id = ?');
    const row = stmt.get(feedbackId);

    if (!row) return null;

    return {
      ID: row.id,
      Timestamp: row.timestamp,
      'Discord User': row.discord_user,
      Email: row.email,
      'Feedback Text': row.feedback_text,
      'Intercom ID': row.intercom_id,
      Status: row.status,
      'Duplicate Count': row.duplicate_count,
      'Similar IDs': row.similar_ids || '',
      'Approval Date': row.approval_date || '',
      id: row.id,
      discordUser: row.discord_user,
      feedbackText: row.feedback_text,
    };
  }

  async updateFeedbackStatus(feedbackId, newStatus) {
    const approvalDate = newStatus === 'approved' ? new Date().toISOString() : null;

    const stmt = this.db.prepare(`
      UPDATE feedback 
      SET status = ?, approval_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const result = stmt.run(newStatus, approvalDate, feedbackId);

    if (result.changes === 0) {
      throw new Error('Feedback not found');
    }

    console.log(`✅ Updated feedback ${feedbackId} status to ${newStatus}`);
  }

  async updateDuplicateCount(feedbackId, newCount) {
    const stmt = this.db.prepare(`
      UPDATE feedback 
      SET duplicate_count = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const result = stmt.run(newCount, feedbackId);

    if (result.changes === 0) {
      throw new Error('Feedback not found');
    }

    console.log(`✅ Updated feedback ${feedbackId} duplicate count to ${newCount}`);
  }

  async updateSimilarIds(feedbackId, similarIds) {
    const stmt = this.db.prepare(`
      UPDATE feedback 
      SET similar_ids = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.run(JSON.stringify(similarIds), feedbackId);
  }
}

class DuplicateDetector {
  constructor() {
    this.feedbackManager = null;
    this.similarityThreshold = 0.8;
  }

  setFeedbackManager(manager) {
    this.feedbackManager = manager;
  }

  async detectDuplicates(feedbackText) {
    try {
      const allFeedback = await this.feedbackManager.getAllFeedback();
      const matches = [];

      for (const fb of allFeedback) {
        const fbText = fb['Feedback Text'] || fb.feedbackText || '';
        if (this.isExactMatch(feedbackText, fbText)) {
          matches.push({
            feedback: fb,
            similarity: 1,
          });
        }
      }

      if (matches.length > 0) {
        return {
          isDuplicate: true,
          matches,
        };
      }

      const semanticMatches = await this.checkSemanticSimilarity(
        feedbackText,
        allFeedback
      );

      return {
        isDuplicate: semanticMatches.length > 0,
        matches: semanticMatches,
      };
    } catch (error) {
      console.warn('⚠️  Duplicate detection failed:', error.message);
      return { isDuplicate: false, matches: [] };
    }
  }

  isExactMatch(text1, text2) {
    const normalize = (str) =>
      str.toLowerCase().trim().replace(/[^\w\s]/g, '');
    return normalize(text1) === normalize(text2);
  }

  async checkSemanticSimilarity(feedbackText, allFeedback) {
    try {
      const semanticUrl = process.env.SEMANTIC_URL || 'http://localhost:5000';
      
      const response = await axios.post(
        `${semanticUrl}/similarity`,
        {
          text1: feedbackText,
          texts: allFeedback.map((f) => f['Feedback Text'] || f.feedbackText),
        },
        { timeout: 5000 }
      );

      const matches = [];
      for (let i = 0; i < response.data.similarities.length; i++) {
        const similarity = response.data.similarities[i];
        if (similarity >= this.similarityThreshold) {
          matches.push({
            feedback: allFeedback[i],
            similarity,
          });
        }
      }

      return matches;
    } catch (error) {
      console.warn('⚠️  Semantic similarity check failed:', error.message);
      return [];
    }
  }

  async checkIntercomDuplicates(feedbackText, intercomToken) {
    try {
      if (!intercomToken) return [];

      const response = await axios.get('https://api.intercom.io/tickets', {
        headers: {
          Authorization: `Bearer ${intercomToken}`,
          'Intercom-Version': '2.14',
        },
      });

      const tickets = response.data.data || [];
      const matches = [];

      for (const ticket of tickets) {
        const ticketText = ticket.description || '';
        if (this.isExactMatch(feedbackText, ticketText)) {
          matches.push({
            feedback: {
              ID: ticket.id,
              'Feedback Text': ticketText,
              source: 'intercom',
              similarity: 1,
            },
            similarity: 1,
          });
        }
      }

      return matches;
    } catch (error) {
      console.warn('⚠️  Failed to check Intercom duplicates:', error.message);
      return [];
    }
  }
}

module.exports = { FeedbackManager, DuplicateDetector };
