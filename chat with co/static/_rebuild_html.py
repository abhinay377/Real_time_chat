"""Rebuild index.html as HTML-only (CSS and JS are now in separate files)."""
import pathlib

src = pathlib.Path(__file__).with_name('index.html')
lines = src.read_text(encoding='utf-8').splitlines(keepends=True)

# HTML body content is lines 562-1109 (1-indexed)
html_body = lines[561:1109]

head = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0"/>
<title>Chat With Co</title>
<meta name="description" content="Chat With Co - Private and secure messaging application"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="/styles.css"/>
</head>
<body>
'''

tail = '''
<script src="/app.js"></script>
</body>
</html>
'''

src.write_text(head + ''.join(html_body) + tail, encoding='utf-8')
new_count = len(src.read_text(encoding='utf-8').splitlines())
print(f'Rebuilt index.html: {new_count} lines')
