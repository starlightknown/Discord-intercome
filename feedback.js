const axios = require('axios');
const { google } = require('googleapis');

class FeedbackManager {
  constructor() {
    this.useLocal = process.env.USE_LOCAL_STORAGE === 'true' || !process.env.GOOGLE_SHEETS_ID;
    this.sheets = null;
    this.spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    this.sheetName = 'Feedback';
    this.initialized = false;
    this.feedback = [];
  }

  async initialize() {
    try {
      if (this.useLocal) {
        this.loadLocalData();
        this.initialized = true;
        console.log('✅ Local JSON storage initialized');
      } else {
        const auth = new google.auth.GoogleAuth({
          keyFile: process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json',
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        this.sheets = google.sheets({ version: 'v4', auth });
        
        await this.ensureSheetExists();
        this.initialized = true;
        console.log('✅ Google Sheets initialized');
      }
    } catch (error) {
      console.error('❌ Failed to initialize storage:', error.message);
      throw error;
    }
  }

  loadLocalData() {
    const fs = require('fs');
    const path = require('path');
    const localFile = './feedback-data.json';

    try {
      if (fs.existsSync(localFile)) {
        const data = fs.readFileSync(localFile, 'utf-8');
        this.feedback = JSON.parse(data);
      } else {
        this.feedback = [];
      }
    } catch (error) {
      console.warn('⚠️  Could not load local data:', error.message);
      this.feedback = [];
    }
  }

  saveLocalData() {
    const fs = require('fs');
    try {
      fs.writeFileSync('./feedback-data.json', JSON.stringify(this.feedback, null, 2));
    } catch (error) {
      console.error('❌ Failed to save local data:', error.message);
    }
  }

  async ensureSheetExists() {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A1`,
      });

      if (!response.data.values) {
        await this.createSheet();
      }
    } catch (error) {
      const statusCode = error?.code || error?.response?.status;
      const apiStatus = error?.response?.data?.error?.status;
      const apiErrors = error?.errors || error?.response?.data?.error?.errors;
      
      const isNotFound =
        statusCode === 404 ||
        apiStatus === 'NOT_FOUND' ||
        (Array.isArray(apiErrors) &&
          apiErrors.some((e) => e.reason === 'notFound'));

      if (isNotFound) {
        await this.createSheet();
        return;
      }

      throw error;
    }
  }

  async createSheet() {
    const headers = [
      'ID',
      'Timestamp',
      'Discord User',
      'Email',
      'Feedback Text',
      'Intercom ID',
      'Status',
      'Duplicate Count',
      'Similar IDs',
      'Approval Date',
    ];

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A1:J1`,
      valueInputOption: 'RAW',
      resource: { values: [headers] },
    });

    console.log('✅ Feedback sheet created with headers');
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

    if (this.useLocal) {
      const feedback = {
        ID: id,
        Timestamp: timestamp,
        'Discord User': discordUser || 'Unknown',
        Email: email,
        'Feedback Text': feedbackText,
        'Intercom ID': intercomId,
        Status: status,
        'Duplicate Count': duplicateCount,
        'Similar IDs': '',
        'Approval Date': '',
      };
      this.feedback.push(feedback);
      this.saveLocalData();
      return { id, ...data, status, timestamp };
    }

    const row = [
      id,
      timestamp,
      discordUser || 'Unknown',
      email,
      feedbackText,
      intercomId,
      status,
      duplicateCount,
      '',
      '',
    ];

    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A:J`,
      valueInputOption: 'RAW',
      resource: { values: [row] },
    });

    return { id, ...data, status, timestamp };
  }

  async getAllFeedback() {
    if (this.useLocal) {
      return this.feedback;
    }

    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A2:J`,
    });

    const rows = response.data.values || [];
    const headers = ['ID', 'Timestamp', 'Discord User', 'Email', 'Feedback Text', 'Intercom ID', 'Status', 'Duplicate Count', 'Similar IDs', 'Approval Date'];

    return rows.map((row) => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] || '';
      });
      return obj;
    });
  }

  async getFeedbackById(feedbackId) {
    const allFeedback = await this.getAllFeedback();
    return allFeedback.find((f) => f.ID === feedbackId) || null;
  }

  async updateFeedbackStatus(feedbackId, newStatus) {
    const allFeedback = await this.getAllFeedback();
    const feedback = allFeedback.find((f) => f.ID === feedbackId);

    if (!feedback) {
      throw new Error('Feedback not found');
    }

    const approvalDate = newStatus === 'approved' ? new Date().toISOString() : '';

    if (this.useLocal) {
      const index = this.feedback.findIndex((f) => f.ID === feedbackId);
      this.feedback[index]['Status'] = newStatus;
      if (approvalDate) {
        this.feedback[index]['Approval Date'] = approvalDate;
      }
      this.saveLocalData();
    } else {
      const rowIndex = allFeedback.findIndex((f) => f.ID === feedbackId);

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!G${rowIndex + 2}`,
        valueInputOption: 'RAW',
        resource: { values: [[newStatus]] },
      });

      if (approvalDate) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${this.sheetName}!J${rowIndex + 2}`,
          valueInputOption: 'RAW',
          resource: { values: [[approvalDate]] },
        });
      }
    }

    console.log(`✅ Updated feedback ${feedbackId} status to ${newStatus}`);
  }

  async updateDuplicateCount(feedbackId, newCount) {
    const allFeedback = await this.getAllFeedback();
    
    if (this.useLocal) {
      const index = this.feedback.findIndex((f) => f.ID === feedbackId);
      if (index !== -1) {
        this.feedback[index]['Duplicate Count'] = newCount;
        this.saveLocalData();
      }
    } else {
      const rowIndex = allFeedback.findIndex((f) => f.ID === feedbackId);

      if (rowIndex !== -1) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${this.sheetName}!H${rowIndex + 2}`,
          valueInputOption: 'RAW',
          resource: { values: [[newCount]] },
        });
      }
    }

    console.log(`✅ Updated feedback ${feedbackId} duplicate count to ${newCount}`);
  }

  async updateSimilarIds(feedbackId, similarIds) {
    const allFeedback = await this.getAllFeedback();
    
    if (this.useLocal) {
      const index = this.feedback.findIndex((f) => f.ID === feedbackId);
      if (index !== -1) {
        this.feedback[index]['Similar IDs'] = JSON.stringify(similarIds);
        this.saveLocalData();
      }
    } else {
      const rowIndex = allFeedback.findIndex((f) => f.ID === feedbackId);

      if (rowIndex !== -1) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${this.sheetName}!I${rowIndex + 2}`,
          valueInputOption: 'RAW',
          resource: { values: [[JSON.stringify(similarIds)]] },
        });
      }
    }
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
