// Mock S3 multipart upload (simplified XML->JSON translation).
// POST /:bucket/:key?uploads -> {UploadId}
// PUT /:bucket/:key?partNumber=N&uploadId=U body=bytes -> {ETag, PartNumber}
// POST /:bucket/:key?uploadId=U body={Parts:[{PartNumber,ETag}]} -> {Location, ETag, VersionId} (completes)
// DELETE /:bucket/:key?uploadId=U -> aborts (remove staged parts)
// GET /:bucket/:key -> {size, etag} (completed object)
// GET /:bucket/:key?uploads -> list in-progress uploads
const http = require('http');
const url = require('url');
const crypto = require('crypto');

const uploads = {}; // uploadId -> {bucket, key, parts: {N: {etag,size,body}}, aborted, completed}
const objects = {}; // bucket/key -> {size, etag, versionId}
const objectVersions = {}; // per key history (for versioned bucket simulation)

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const pm = u.pathname.match(/^\/([^/]+)\/(.+)$/);
  if (!pm) return json(res, 404, { message: 'not found' });
  const [_, bucket, key] = pm;
  const objKey = `${bucket}/${key}`;

  // Initiate multipart
  if (req.method === 'POST' && 'uploads' in u.query && !u.query.uploadId) {
    const uploadId = crypto.randomBytes(8).toString('hex');
    uploads[uploadId] = { uploadId, bucket, key, parts: {}, aborted: false, completed: false, initiated: new Date().toISOString() };
    return json(res, 200, { UploadId: uploadId, Bucket: bucket, Key: key });
  }
  // Upload part
  if (req.method === 'PUT' && u.query.partNumber && u.query.uploadId) {
    const up = uploads[u.query.uploadId];
    if (!up || up.aborted) return json(res, 404, { message: 'no upload' });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const etag = crypto.createHash('md5').update(body).digest('hex');
      up.parts[u.query.partNumber] = { partNumber: parseInt(u.query.partNumber, 10), etag, size: body.length };
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: `"${etag}"` });
      res.end(JSON.stringify({ ETag: etag, PartNumber: parseInt(u.query.partNumber, 10) }));
    });
    return;
  }
  // Complete multipart
  if (req.method === 'POST' && u.query.uploadId) {
    const up = uploads[u.query.uploadId];
    if (!up || up.aborted) return json(res, 404, { message: 'no upload' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { Parts } = JSON.parse(body);
      let total = 0;
      for (const p of Parts) {
        const sp = up.parts[p.PartNumber];
        if (!sp || sp.etag !== p.ETag.replace(/"/g, '')) return json(res, 400, { message: `part ${p.PartNumber} mismatch` });
        total += sp.size;
      }
      // If object already exists, save previous version for possible revert
      const prev = objects[objKey];
      const versionId = crypto.randomBytes(8).toString('hex');
      objectVersions[objKey] = objectVersions[objKey] || [];
      if (prev) objectVersions[objKey].push(prev);
      objects[objKey] = { bucket, key, size: total, etag: crypto.randomBytes(8).toString('hex'), versionId, uploadId: up.uploadId };
      up.completed = true;
      json(res, 200, { Location: `https://s3/${bucket}/${key}`, Bucket: bucket, Key: key, ETag: objects[objKey].etag, VersionId: versionId });
    });
    return;
  }
  // Abort multipart
  if (req.method === 'DELETE' && u.query.uploadId) {
    const up = uploads[u.query.uploadId];
    if (!up) return json(res, 404, { message: 'no upload' });
    up.aborted = true;
    up.parts = {};
    return json(res, 204, {});
  }
  // GET object
  if (req.method === 'GET' && !u.query.uploadId && !('uploads' in u.query)) {
    const o = objects[objKey];
    if (!o) return json(res, 404, { message: 'no object' });
    return json(res, 200, o);
  }
  // DELETE object
  if (req.method === 'DELETE' && !u.query.uploadId) {
    if (!objects[objKey]) return json(res, 404, { message: 'no object' });
    delete objects[objKey];
    return json(res, 204, {});
  }
  // PUT object (restore prior version)
  if (req.method === 'PUT' && !u.query.uploadId) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { size, etag, versionId } = JSON.parse(body);
      objects[objKey] = { bucket, key, size, etag, versionId };
      json(res, 200, objects[objKey]);
    });
    return;
  }
  // List in-progress uploads
  if (req.method === 'GET' && 'uploads' in u.query) {
    return json(res, 200, { Uploads: Object.values(uploads).filter((u2) => u2.bucket === bucket && u2.key === key && !u2.completed && !u2.aborted) });
  }
  json(res, 404, { message: 'not matched' });
});

const PORT = process.env.PORT || 4106;
server.listen(PORT, () => console.log(`[mock-s3] listening on ${PORT}`));
