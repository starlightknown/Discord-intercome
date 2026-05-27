const { google } = require('googleapis');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

class FeedbackManager {
  constructor() {
    this.sheets = null;
    this.spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    this.sheetName = 'Feedback';
    this.initialized = false;
  }

  async initialize() {
    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.sheets = google.sheets({ version: 'v4', auth });
      
      await this.ensureSheetExists();
      this.initialized = true;
      console.log('✅ Google Sheets initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Google Sheets:', error.message);
      throw error;
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

    const row = [
      id,
      timestamp,
      discordUser || 'Unknown',
      email,
      feedbackText,
      intercomId,
      status,
      duplicateCount,
      '', // Similar IDs (populated on duplicate detection)
      '', // Approval Date
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

  async updateFeedbackStatus(feedbackId, newStatus) {
    const allFeedback = await this.getAllFeedback();
    const rowIndex = allFeedback.findIndex((f) => f.ID === feedbackId);

    if (rowIndex === -1) {
      throw new Error('Feedback not found');
    }

    const approvalDate = newStatus === 'approved' ? new Date().toISOString() : '';

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

    console.log(`✅ Updated feedback ${feedbackId} status to ${newStatus}`);
  }

  async updateDuplicateCount(feedbackId, count) {
    const allFeedback = await this.getAllFeedback();
    const rowIndex = allFeedback.findIndex((f) => f.ID === feedbackId);

    if (rowIndex === -1) {
      throw new Error('Feedback not found');
    }

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!H${rowIndex + 2}`,
      valueInputOption: 'RAW',
      resource: { values: [[count]] },
    });
  }

  async getFeedbackById(feedbackId) {
    const allFeedback = await this.getAllFeedback();
    return allFeedback.find((f) => f.ID === feedbackId);
  }
}

class DuplicateDetector {
  constructor() {
    this.similarityThreshold = 0.75;
    this.feedbackManager = null;
  }

  setFeedbackManager(manager) {
    this.feedbackManager = manager;
  }

  exactMatch(text, existingFeedback) {
    const normalizedText = text.toLowerCase().trim();
    return existingFeedback
      .filter(
        (f) => f['Feedback Text'].toLowerCase().trim() === normalizedText
      )
      .map((f) => ({
        feedback: f,
        similarity: 1,
      }));
  }

  async semanticSimilarity(text, existingFeedback) {
    try {
      const response = await axios.post('http://localhost:5000/similarity', {
        text1: text,
        texts: existingFeedback.map((f) => f['Feedback Text']),
      });

      const matches = [];
      response.data.scores.forEach((score, index) => {
        if (score >= this.similarityThreshold) {
          matches.push({
            feedback: existingFeedback[index],
            similarity: score,
          });
        }
      });

      return matches;
    } catch (error) {
      console.warn('⚠️  Semantic similarity check failed:', error.message);
      return [];
    }
  }

  async detectDuplicates(newFeedbackText) {
    const allFeedback = await this.feedbackManager.getAllFeedback();
    const activeFeedback = allFeedback.filter((f) => f.Status !== 'rejected');

    const exactMatches = this.exactMatch(newFeedbackText, activeFeedback);
    if (exactMatches.length > 0) {
      return {
        isDuplicate: true,
        type: 'exact',
        matches: exactMatches,
      };
    }

    const semanticMatches = await this.semanticSimilarity(
      newFeedbackText,
      activeFeedback
    );
    if (semanticMatches.length > 0) {
      return {
        isDuplicate: true,
        type: 'semantic',
        matches: semanticMatches,
      };
    }

    return { isDuplicate: false, type: null, matches: [] };
  }

  async checkIntercomDuplicates(text, intercomToken) {
    try {
      const response = await axios.get(
        'https://api.intercom.io/tickets?sort=-created_at&limit=100',
        {
          headers: {
            Authorization: `Bearer ${intercomToken}`,
            'Intercom-Version': '2.14',
          },
        }
      );

      const feedbackTickets = response.data.data || [];
      const matches = [];

      for (const ticket of feedbackTickets) {
        const ticketBody = ticket.ticket_attributes?._default_description_ || '';
        if (this.isSimilarText(text, ticketBody)) {
          matches.push({
            feedback: {
              ID: ticket.id,
              'Feedback Text': ticketBody,
              source: 'intercom',
              title: ticket.ticket_attributes?._default_title_,
            },
            similarity: this.calculateSimilarity(text, ticketBody),
          });
        }
      }

      return matches;
    } catch (error) {
      console.warn('⚠️  Failed to check Intercom duplicates:', error.message);
      return [];
    }
  }

  isSimilarText(text1, text2) {
    const normalize = (t) => t.toLowerCase().trim();
    const t1 = normalize(text1);
    const t2 = normalize(text2);

    const words1 = new Set(t1.split(/\s+/));
    const words2 = new Set(t2.split(/\s+/));
    const intersection = new Set([...words1].filter((x) => words2.has(x)));

    const similarity = intersection.size / Math.max(words1.size, words2.size);
    return similarity >= this.similarityThreshold;
  }

  calculateSimilarity(text1, text2) {
    const normalize = (t) => t.toLowerCase().trim();
    const t1 = normalize(text1);
    const t2 = normalize(text2);

    const words1 = new Set(t1.split(/\s+/));
    const words2 = new Set(t2.split(/\s+/));
    const intersection = new Set([...words1].filter((x) => words2.has(x)));

    return intersection.size / Math.max(words1.size, words2.size);
  }
}

module.exports = { FeedbackManager, DuplicateDetector };
