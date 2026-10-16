import multer from 'multer';
import type { Request, Response } from 'express';
import DictionaryEntry from '../models/DictionaryEntry';

// Multer for JSON import (memory storage — no disk write)
const uploadJson = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req: Request, file: Express.Multer.File, cb: any) {
    if (file.originalname.toLowerCase().endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('Only .json files are accepted'), false);
    }
  },
}).single('jsonFile');

const VALID_POS = ['noun', 'verb', 'adjective', 'adverb', 'preposition', 'conjunction', 'interjection', 'determiner', 'pronoun', 'phrase'];
const VALID_CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const VALID_SOURCES = ['stardict', 'wiktionary', 'manual', 'user'];

const dictionaryController = {
  // GET /dictionary
  async getIndex(req: Request, res: Response) {
    try {
      const { search = '', pos = '', cefrLevel = '', source = '', published = '', page = 1 } = req.query as any;

      // AJAX endpoint for lesson entry picker
      if (req.query.format === 'json') {
        const result = await DictionaryEntry.getAll({ search, page: 1, limit: 20 });
        return res.json({ entries: result.rows });
      }

      const [result, total, missingIpa, tags] = await Promise.all([
        DictionaryEntry.getAll({ search, pos, cefrLevel, source, published, page, limit: 20 }),
        DictionaryEntry.count(),
        DictionaryEntry.countMissingIpa(),
        DictionaryEntry.getAllTags(),
      ]);

      res.render('dictionary/index', {
        title: 'Dictionary',
        active: 'dictionary',
        entries: result.rows,
        pagination: result,
        stats: { total, missingIpa, hasIpa: total - missingIpa },
        tags,
        filters: { search, pos, cefrLevel, source, published },
      });
    } catch (err) {
      console.error('[Dictionary] getIndex error:', err);
      req.flash('error', 'Failed to load dictionary list');
      return res.redirect('/dashboard');
    }
  },

  // GET /dictionary/create
  async getCreate(req: Request, res: Response) {
    try {
      const tags = await DictionaryEntry.getAllTags();
      res.render('dictionary/create', {
        title: 'Add New Word',
        active: 'dictionary',
        tags,
        VALID_POS,
        VALID_CEFR,
        VALID_SOURCES,
      });
    } catch (err) {
      console.error('[Dictionary] getCreate error:', err);
      req.flash('error', 'Failed to load form');
      return res.redirect('/dictionary');
    }
  },

  // POST /dictionary/create
  async postCreate(req: Request, res: Response) {
    try {
      const { headword, lemma, meaning_vi } = req.body;
      const errors: string[] = [];

      if (!headword || !headword.trim()) errors.push('Headword is required');
      if (!lemma || !lemma.trim()) errors.push('Lemma is required');
      if (!meaning_vi || !meaning_vi.trim()) errors.push('Vietnamese meaning is required');

      if (errors.length > 0) {
        req.flash('error', errors.join('. '));
        return res.redirect('/dictionary/create');
      }

      const existing = await DictionaryEntry.findByHeadwordLemma(
        headword.trim().toLowerCase(),
        lemma.trim().toLowerCase()
      );
      if (existing) {
        req.flash('error', 'This word (headword + lemma) already exists in the dictionary');
        return res.redirect('/dictionary/create');
      }

      const pos = Array.isArray(req.body.pos) ? req.body.pos : (req.body.pos ? [req.body.pos] : []);
      const tagIds = Array.isArray(req.body.tagIds) ? req.body.tagIds : (req.body.tagIds ? [req.body.tagIds] : []);

      const entry = await DictionaryEntry.create({ ...req.body, pos, created_by: req.session.admin.id }, tagIds);
      req.flash('success', `Word "${entry.headword}" added successfully`);
      return res.redirect(`/dictionary/${entry.id}`);
    } catch (err) {
      console.error('[Dictionary] postCreate error:', err);
      req.flash('error', 'Đã xảy ra lỗi. Vui lòng thử lại.');
      return res.redirect('/dictionary/create');
    }
  },

  // GET /dictionary/import
  getImport(req: Request, res: Response) {
    res.render('dictionary/import', {
      title: 'Import JSON',
      active: 'dictionary',
      result: null,
    });
  },

  // POST /dictionary/import
  postImport(req: Request, res: Response) {
    uploadJson(req, res, async (err: any) => {
      if (err) {
        req.flash('error', err.message || 'File upload error');
        return res.redirect('/dictionary/import');
      }
      if (!req.file) {
        req.flash('error', 'Please select a JSON file');
        return res.redirect('/dictionary/import');
      }
      try {
        let jsonArray: any;
        try {
          jsonArray = JSON.parse(req.file.buffer.toString('utf8'));
        } catch {
          req.flash('error', 'File is not valid JSON');
          return res.redirect('/dictionary/import');
        }
        if (!Array.isArray(jsonArray)) {
          req.flash('error', 'JSON file must be an array of words');
          return res.redirect('/dictionary/import');
        }

        const result = await DictionaryEntry.importFromJson(jsonArray, req.session.admin.id);
        return res.render('dictionary/import', {
          title: 'Import JSON',
          active: 'dictionary',
          result,
        });
      } catch (importErr) {
        console.error('[Dictionary] postImport error:', importErr);
        req.flash('error', 'An error occurred during import. Please try again.');
        return res.redirect('/dictionary/import');
      }
    });
  },

  // GET /dictionary/:id
  async getShow(req: Request, res: Response) {
    try {
      const entry = await DictionaryEntry.findById(req.params.id as string);
      if (!entry) {
        req.flash('error', 'Word not found');
        return res.redirect('/dictionary');
      }
      res.render('dictionary/show', {
        title: entry.headword,
        active: 'dictionary',
        entry,
      });
    } catch (err) {
      console.error('[Dictionary] getShow error:', err);
      req.flash('error', 'Failed to load word information');
      return res.redirect('/dictionary');
    }
  },

  // GET /dictionary/:id/edit
  async getEdit(req: Request, res: Response) {
    try {
      const [entry, tags] = await Promise.all([
        DictionaryEntry.findById(req.params.id as string),
        DictionaryEntry.getAllTags(),
      ]);
      if (!entry) {
        req.flash('error', 'Word not found');
        return res.redirect('/dictionary');
      }
      res.render('dictionary/edit', {
        title: `Edit — ${entry.headword}`,
        active: 'dictionary',
        entry,
        tags,
        VALID_POS,
        VALID_CEFR,
        VALID_SOURCES,
      });
    } catch (err) {
      console.error('[Dictionary] getEdit error:', err);
      req.flash('error', 'Failed to load edit form');
      return res.redirect('/dictionary');
    }
  },

  // POST /dictionary/:id/edit
  async postEdit(req: Request, res: Response) {
    try {
      const { id } = req.params as { id: string };
      const { headword, lemma, meaning_vi } = req.body;
      const errors: string[] = [];

      if (!headword || !headword.trim()) errors.push('Headword không được để trống');
      if (!lemma || !lemma.trim()) errors.push('Lemma không được để trống');
      if (!meaning_vi || !meaning_vi.trim()) errors.push('Nghĩa tiếng Việt không được để trống');

      if (errors.length > 0) {
        req.flash('error', errors.join('. '));
        return res.redirect(`/dictionary/${id}/edit`);
      }

      // Check uniqueness excluding self
      const existing = await DictionaryEntry.findByHeadwordLemma(
        headword.trim().toLowerCase(),
        lemma.trim().toLowerCase()
      );
      if (existing && existing.id !== id) {
        req.flash('error', 'This word (headword + lemma) already exists in the dictionary');
        return res.redirect(`/dictionary/${id}/edit`);
      }

      const pos = Array.isArray(req.body.pos) ? req.body.pos : (req.body.pos ? [req.body.pos] : []);
      const tagIds = Array.isArray(req.body.tagIds) ? req.body.tagIds : (req.body.tagIds ? [req.body.tagIds] : []);

      await DictionaryEntry.update(id, { ...req.body, pos }, tagIds, req.session.admin.id);
      req.flash('success', 'Word updated successfully');
      return res.redirect(`/dictionary/${id}`);
    } catch (err) {
      console.error('[Dictionary] postEdit error:', err);
      req.flash('error', 'Đã xảy ra lỗi. Vui lòng thử lại.');
      return res.redirect(`/dictionary/${req.params.id}/edit`);
    }
  },

  // POST /dictionary/:id/delete
  async postDelete(req: Request, res: Response) {
    try {
      const { id } = req.params as { id: string };
      const { confirm_text } = req.body;

      const entry = await DictionaryEntry.findById(id);
      if (!entry) {
        req.flash('error', 'Word not found');
        return res.redirect('/dictionary');
      }

      if (confirm_text !== `DELETE ${entry.headword}`) {
        req.flash('error', 'Confirmation text is incorrect. Please try again.');
        return res.redirect(`/dictionary/${id}`);
      }

      await DictionaryEntry.delete(id);
      req.flash('success', `Word "${entry.headword}" deleted`);
      return res.redirect('/dictionary');
    } catch (err) {
      console.error('[Dictionary] postDelete error:', err);
      req.flash('error', 'Đã xảy ra lỗi. Vui lòng thử lại.');
      return res.redirect('/dictionary');
    }
  },
};

export = dictionaryController;
