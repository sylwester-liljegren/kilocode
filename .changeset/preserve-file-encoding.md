---
"@kilocode/cli": minor
---

Detect and preserve the original text encoding of files when the agent reads or edits them. Source trees in Japanese, Chinese, Korean, Cyrillic, or Western European encodings no longer get mangled when Kilo touches them, and non-UTF-8 files are displayed correctly to the model instead of as garbled text.

Supported: UTF-8, UTF-16 with BOM, and common legacy Latin and CJK encodings (Shift_JIS, EUC-JP, GB2312, Big5, EUC-KR, Windows-1251, KOI8-R, ISO-8859, and others).

Not supported: UTF-16 without BOM, UTF-32.
