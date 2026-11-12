const fs = require('fs');

const output = 'Options_Chain_EC2_Deployment_Guide.pdf';
const lines = [
  'OPTIONS CHAIN APP - EC2 PRODUCTION DEPLOYMENT',
  'Project path: /home/ubuntu/Fyers-OptiochainV1',
  '',
  'Before starting',
  'Point app.yourdomain.com to the EC2 Elastic IP. In the AWS Security Group, allow',
  'TCP 22 (only your IP), 80, and 443. Replace app.yourdomain.com with your domain.',
  'Do not share or commit backend/.env.',
  '',
  '1. Install server software',
  'sudo apt update && sudo apt upgrade -y',
  'sudo apt install -y git nginx certbot python3-certbot-nginx software-properties-common build-essential',
  'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -',
  'sudo apt install -y nodejs',
  'sudo add-apt-repository ppa:deadsnakes/ppa -y',
  'sudo apt update && sudo apt install -y python3.13 python3.13-venv python3.13-dev',
  '',
  '2. Backend installation',
  'cd /home/ubuntu/Fyers-OptiochainV1/backend',
  'python3.13 -m venv .venv',
  '.venv/bin/python -m pip install --upgrade pip',
  '.venv/bin/python -m pip install -e ".[market-stream]"',
  '.venv/bin/python -m pip install --no-deps fyers-apiv3==3.1.15',
  '.venv/bin/python -m pip install "httpx==0.28.1"',
  'nano .env',
  '',
  'Use these important .env values',
  'ENVIRONMENT=production',
  'FRONTEND_ORIGIN=https://app.yourdomain.com',
  'DATABASE_URL=sqlite:////home/ubuntu/Fyers-OptiochainV1/backend/options_chain.db',
  'ADMIN_EMAIL=your-admin-email@example.com',
  'FYERS_REDIRECT_URI=https://app.yourdomain.com/api/fyers/callback',
  'Also add FYERS_CLIENT_ID, FYERS_CLIENT_SECRET, FYERS_PIN, and FYERS_API_BASE_URL.',
  '',
  'Generate secrets in the backend directory',
  '.venv/bin/python -c "import secrets; print(secrets.token_urlsafe(48))"',
  '.venv/bin/python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"',
  'Put first output in SECRET_KEY and second in FYERS_ENCRYPTION_KEY.',
  '.venv/bin/alembic upgrade head',
  '',
  '3. Frontend',
  'cd /home/ubuntu/Fyers-OptiochainV1/frontend',
  'Create .env.local with:',
  'API_URL=http://127.0.0.1:8000',
  'NEXT_PUBLIC_API_WS_URL=wss://app.yourdomain.com/admin/fyers/stream',
  'npm ci',
  'npm run build',
  '',
  '4. Persistent services',
  'Create /etc/systemd/system/options-backend.service:',
  '[Service] User=ubuntu',
  'WorkingDirectory=/home/ubuntu/Fyers-OptiochainV1/backend',
  'ExecStart=/home/ubuntu/Fyers-OptiochainV1/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000',
  'Restart=always',
  '',
  'Create /etc/systemd/system/options-frontend.service:',
  '[Service] User=ubuntu',
  'WorkingDirectory=/home/ubuntu/Fyers-OptiochainV1/frontend',
  'Environment=NODE_ENV=production',
  'Environment=PORT=3000',
  'ExecStart=/usr/bin/npm run start',
  'Restart=always',
  '',
  'For both service files add:',
  '[Install]',
  'WantedBy=multi-user.target',
  'Then run:',
  'sudo systemctl daemon-reload',
  'sudo systemctl enable --now options-backend options-frontend',
  'sleep 5',
  'curl http://127.0.0.1:8000/health',
  '',
  '5. Nginx and HTTPS',
  'Nginx must proxy / to http://127.0.0.1:3000 and /admin/fyers/stream to',
  'http://127.0.0.1:8000 with WebSocket Upgrade and Connection headers.',
  'sudo nginx -t && sudo systemctl restart nginx',
  'sudo certbot --nginx -d app.yourdomain.com',
  'Choose the HTTP-to-HTTPS redirect option.',
  '',
  '6. Admin account',
  'Set ADMIN_EMAIL in backend/.env. Restart the backend, then sign up on the website',
  'using exactly that email address. The account automatically becomes administrator.',
  'sudo systemctl restart options-backend',
  '',
  'Useful commands',
  'sudo journalctl -u options-backend -f',
  'sudo journalctl -u options-frontend -f',
  'sudo systemctl restart options-backend options-frontend',
];

const escape = (value) => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const perPage = 46;
const pages = [];
for (let index = 0; index < lines.length; index += perPage) pages.push(lines.slice(index, index + perPage));
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
const pageIds = pages.map((_, index) => 3 + index * 2);
objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
pages.forEach((page, index) => {
  const pageId = pageIds[index];
  const contentId = pageId + 1;
  const stream = ['BT', '/F1 10 Tf', '50 800 Td', '14 TL'];
  page.forEach((line, lineIndex) => {
    if (lineIndex === 0) stream.push('/F1 13 Tf');
    stream.push(`(${escape(line)}) Tj`, 'T*');
    if (lineIndex === 0) stream.push('/F1 10 Tf');
  });
  stream.push('ET');
  const content = stream.join('\n');
  objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${2 + pages.length * 2 + 1} 0 R >> >> /Contents ${contentId} 0 R >>`;
  objects[contentId - 1] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
});
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
let pdf = '%PDF-1.4\n';
const offsets = [0];
objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(output, pdf, 'binary');
console.log(output);
