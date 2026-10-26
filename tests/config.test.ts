import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@personal-context/config';

const valid = { DATABASE_URL: 'postgresql://user:pass@localhost/db' };
test('configuration rejects missing database and malformed protocols without exposing credentials', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'https://private:secret@localhost/db' }), /^Error: DATABASE_URL must identify/);
});
test('configuration rejects invalid ports', () => {
  for (const API_PORT of ['0', '65536', '3000junk', 'NaN', '']) assert.throws(() => loadConfig({ ...valid, API_PORT }), /API_PORT/);
  assert.equal(loadConfig(valid).apiPort, 3000);
});

test('model settings must be complete, explicit and dimension compatible', () => {
  assert.throws(() => loadConfig({ ...valid, EMBEDDING_MODEL: 'example' }), /requires endpoint/);
  assert.throws(() => loadConfig({ ...valid, EMBEDDING_DIMENSIONS: '3' }), /requires embedding/);
  assert.throws(() => loadConfig({ ...valid, MAX_MEDIA_BYTES: '-1' }), /MAX_MEDIA_BYTES/);
  assert.throws(() => loadConfig({ ...valid, BACKFILL_DAYS: '0' }), /BACKFILL_DAYS/);
  assert.throws(() => loadConfig({ ...valid, CLASSIFIER_ENDPOINT: 'http://remote.example', CLASSIFIER_MODEL: 'x', CLASSIFIER_VERSION: '1' }), /HTTPS/);
  const config = loadConfig(valid);
  assert.equal(config.embedding, null);
  assert.equal(config.maxMediaBytes, 20971520);
  assert.equal(config.backfillDays, 30);
  assert.equal(config.calendarFutureDays, 90);
});
test('vision has a longer bounded timeout while invalid timeout configuration fails early',()=>{
 const vision={...valid,VISION_ENDPOINT:'http://localhost:11434',VISION_MODEL:'test',VISION_VERSION:'1'};
 assert.equal(loadConfig(vision).vision?.timeoutMs,180000);
 assert.throws(()=>loadConfig({...vision,VISION_TIMEOUT_MS:'0'}),/VISION_TIMEOUT_MS/);
 assert.throws(()=>loadConfig({...vision,VISION_TIMEOUT_MS:'600001'}),/VISION_TIMEOUT_MS/);
});
