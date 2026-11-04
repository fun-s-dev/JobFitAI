import { createRequire } from 'node:module';
import { makeTextPdf } from '../../helpers/makePdf.js';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
const {
  stripMarkdownLinks,
  safeHttpUrl,
  detectSection,
  extractResumeExtras,
  gradeForEntries,
  applyResumeExtras,
} = require('../../../src/v2/core/resumeExtras');

// Shaped like a real LaTeX resume as read by pdf-parse with hyperlinks on. Synthetic person.
const RESUME = [
  'RILEY TESTER',
  '+1 555 0100 | riley@example.com | [LinkedIn](https://www.linkedin.com/in/riley-test) | [CodeChef](https://www.codechef.com/users/riley) | [GitHub](https://github.com/riley-test)',
  'Summary',
  'Computer Science undergraduate.',
  'Education',
  'Sample University, Mumbai September 2024 – Present',
  'B. Tech in Computer Science (Data Science) CGPA:9.20(till sem IV)',
  'Projects',
  'JobFitAI | React, Node.js | [GitHub](https://github.com/riley-test/jobfit)',
  '- Built an interview prep platform.',
  'Certifications and Achievements',
  '- CodeChef: Achieved 2-Star Rating (Max Rating: 1461) in Competitive Programming.',
  '- Completed Python for Data Science (Elite + Silver) certification by NPTEL (IIT Madras) [[Certificate]](https://nptel.ac.in/cert/123).',
  '- Completed the AWS Academy Cloud Foundations course by Amazon Web Services (AWS), gaining',
  'foundational knowledge of cloud computing. [[Badge]](https://example.com/badge)',
  '-- 1 of 1 --',
].join('\n');

describe('core/resumeExtras (pure)', () => {
  describe('stripMarkdownLinks / safeHttpUrl', () => {
    it('keeps the label of a link, including a label with its own brackets', () => {
      expect(stripMarkdownLinks('see [LinkedIn](https://a.b/c) now')).toBe('see LinkedIn now');
      expect(stripMarkdownLinks('[[Certificate]](https://a.b/c).')).toBe('[Certificate].');
      expect(stripMarkdownLinks('no links here')).toBe('no links here');
    });

    it('accepts only plain http(s) URLs', () => {
      expect(safeHttpUrl('https://github.com/riley')).toBe('https://github.com/riley');
      expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
      expect(safeHttpUrl('data:text/html,<script>')).toBeNull();
      expect(safeHttpUrl('https://user:pass@evil.example')).toBeNull();
      expect(safeHttpUrl('not a url')).toBeNull();
      expect(safeHttpUrl(`https://a.example/${'x'.repeat(400)}`)).toBeNull();
    });
  });

  describe('detectSection', () => {
    it.each([
      ['Education', 'education'],
      ['TECHNICAL SKILLS', 'skills'],
      ['Projects', 'projects'],
      ['Certifications and Achievements', 'certifications'],
      ['CERTIFICATIONS & ACHIEVEMENTS', 'certifications'],
      ['Awards', 'certifications'],
      ['Work Experience', 'experience'],
      ['Summary', 'summary'],
    ])('%s -> %s', (line, expected) => {
      expect(detectSection(line)).toBe(expected);
    });

    it('does not treat ordinary lines or bullets as headings', () => {
      expect(detectSection('- Built an education platform')).toBeNull();
      expect(detectSection('Education platform for schools with many features and a long name that is not a heading')).toBeNull();
      expect(detectSection('JobFitAI | React, Node.js')).toBeNull();
    });
  });

  describe('extractResumeExtras', () => {
    const extras = extractResumeExtras(RESUME);

    it('collects the header links with their labels and URLs', () => {
      const header = extras.links.filter((l) => l.section === 'header');
      expect(header.map((l) => l.label)).toEqual(['LinkedIn', 'CodeChef', 'GitHub']);
      expect(header[0].url).toBe('https://www.linkedin.com/in/riley-test');
    });

    it('records which section each link was in', () => {
      expect(extras.links.find((l) => l.url === 'https://github.com/riley-test/jobfit').section).toBe('projects');
      expect(extras.links.find((l) => l.url === 'https://nptel.ac.in/cert/123').section).toBe('certifications');
    });

    it('extracts each certification / achievement as written, joins wrapped lines, and keeps its links', () => {
      expect(extras.certifications).toHaveLength(3);
      expect(extras.certifications[0].text).toBe('CodeChef: Achieved 2-Star Rating (Max Rating: 1461) in Competitive Programming.');
      expect(extras.certifications[0].links).toEqual([]);

      expect(extras.certifications[1].text).toContain('Python for Data Science');
      expect(extras.certifications[1].links).toEqual([{ label: '[Certificate]', url: 'https://nptel.ac.in/cert/123' }]);

      // the third bullet wraps over two lines
      expect(extras.certifications[2].text).toMatch(/gaining foundational knowledge of cloud computing\./);
      expect(extras.certifications[2].links[0].url).toBe('https://example.com/badge');
    });

    it('does not mistake the PDF page marker for a certification', () => {
      expect(extras.certifications.some((c) => /of 1/.test(c.text))).toBe(false);
    });

    it('finds the CGPA with its note', () => {
      expect(extras.education.grades).toHaveLength(1);
      expect(extras.education.grades[0].text).toBe('CGPA: 9.20 (till sem IV)');
    });

    it('is safe on empty or odd input', () => {
      expect(extractResumeExtras('')).toMatchObject({ links: [], certifications: [], education: { grades: [] } });
      expect(extractResumeExtras(undefined).links).toEqual([]);
      expect(extractResumeExtras('[x](javascript:alert(1))').links).toEqual([]);
    });

    it('ignores links that are not web URLs', () => {
      const e = extractResumeExtras('Certifications\n- Item [[Cert]](javascript:alert(1)) and [ok](https://ok.example/x)');
      expect(e.certifications[0].links).toEqual([{ label: 'ok', url: 'https://ok.example/x' }]);
    });
  });

  describe('grades', () => {
    it.each([
      ['Education\nSample University\nB.Tech CGPA: 8.7/10', 'CGPA: 8.7 / 10'],
      ['Education\nSample University\nB.Tech GPA 3.8', 'GPA: 3.8'],
      ['Education\nSample University\nClass XII Percentage: 92.4%', 'Percentage: 92.4'],
    ])('reads the grade from %j', (text, expected) => {
      expect(extractResumeExtras(text).education.grades[0].text).toBe(expected);
    });

    it('does not read a grade outside the education section', () => {
      expect(extractResumeExtras('Projects\n- Improved CGPA calculator accuracy to 99').education.grades).toEqual([]);
    });

    it('gives the grade to the only education entry, or to the best matching entry', () => {
      const education = { lines: ['Sample University', 'B.Tech in CS CGPA 9.2', 'City College', 'Diploma in IT'], grades: [{ text: 'CGPA: 9.2', lineIndex: 1 }] };
      const single = gradeForEntries([{ id: 'edu0', school: 'Anything', degree: 'Anything' }], education);
      expect(single.get('edu0')).toBe('CGPA: 9.2');

      const two = gradeForEntries(
        [
          { id: 'edu0', school: 'Sample University', degree: 'B.Tech in CS' },
          { id: 'edu1', school: 'City College', degree: 'Diploma in IT' },
        ],
        education
      );
      expect(two.get('edu0')).toBe('CGPA: 9.2');
      expect(two.has('edu1')).toBe(false);
    });
  });

  describe('applyResumeExtras', () => {
    const extras = extractResumeExtras(RESUME);
    const base = {
      name: 'RILEY TESTER',
      contact: ['+1 555 0100', 'riley@example.com', 'LinkedIn', 'GitHub'],
      education: [{ id: 'edu0', school: 'Sample University', degree: 'B. Tech in Computer Science (Data Science)', dates: '' }],
      projects: [],
    };

    it('adds header links, certifications and the grade, and replaces bare link labels in the contact line', () => {
      const out = applyResumeExtras({ exportDraft: base, extras });
      expect(out.links.map((l) => l.label)).toEqual(['LinkedIn', 'CodeChef', 'GitHub']);
      expect(out.contact).toEqual(['+1 555 0100', 'riley@example.com']); // "LinkedIn"/"GitHub" now appear once, as links
      expect(out.certifications).toHaveLength(3);
      expect(out.education[0].grade).toBe('CGPA: 9.20 (till sem IV)');
    });

    it('only uses links from the header area as profile links (project links are not added to the header)', () => {
      const out = applyResumeExtras({ exportDraft: base, extras });
      expect(out.links.some((l) => l.url.includes('jobfit'))).toBe(false);
    });

    it('returns the draft unchanged when there are no extras (resumes uploaded before this feature)', () => {
      expect(applyResumeExtras({ exportDraft: base, extras: null })).toBe(base);
      expect(applyResumeExtras({ exportDraft: base, extras: undefined })).toBe(base);
    });

    it('drops unsafe URLs even if they were stored', () => {
      const out = applyResumeExtras({
        exportDraft: base,
        extras: {
          links: [{ label: 'Evil', url: 'javascript:alert(1)', section: 'header' }],
          certifications: [{ text: 'Cert', links: [{ label: 'x', url: 'data:text/html,hi' }] }],
          education: { lines: [], grades: [] },
        },
      });
      expect(out.links).toEqual([]);
      expect(out.certifications[0].links).toEqual([]);
    });
  });

  describe('on a real PDF built with clickable labels', () => {
    it('recovers the hidden URLs from a PDF and reproduces the plain resume text', async () => {
      const pdf = makeTextPdf([
        'RILEY TESTER',
        ['+1 555 0100 | riley@example.com | ', { text: 'LinkedIn', url: 'https://www.linkedin.com/in/riley-test' }, ' | ', { text: 'GitHub', url: 'https://github.com/riley-test' }],
        'EDUCATION',
        'Sample University, Mumbai',
        'B.Tech in Computer Science CGPA: 9.20 (till sem IV)',
        'CERTIFICATIONS AND ACHIEVEMENTS',
        ['- Completed Python for Data Science by NPTEL ', { text: '[Certificate]', url: 'https://nptel.ac.in/cert/123' }],
        '- Solved 200+ problems across Codeforces and LeetCode.',
      ]);
      const linked = await new PDFParse(Uint8Array.from(pdf)).getText({ parseHyperlinks: true });
      const plain = await new PDFParse(Uint8Array.from(pdf)).getText();
      const norm = (s) => s.replace(/\s+/g, ' ').trim();

      expect(norm(stripMarkdownLinks(linked.text))).toBe(norm(plain.text)); // the stored resume text is unchanged

      const extras = extractResumeExtras(linked.text);
      expect(extras.links.filter((l) => l.section === 'header').map((l) => l.url)).toEqual([
        'https://www.linkedin.com/in/riley-test',
        'https://github.com/riley-test',
      ]);
      expect(extras.certifications.map((c) => c.text)).toEqual([
        'Completed Python for Data Science by NPTEL [Certificate]',
        'Solved 200+ problems across Codeforces and LeetCode.',
      ]);
      expect(extras.certifications[0].links[0].url).toBe('https://nptel.ac.in/cert/123');
      expect(extras.education.grades[0].text).toBe('CGPA: 9.20 (till sem IV)');
    });
  });
});
