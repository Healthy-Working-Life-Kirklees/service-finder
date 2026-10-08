// Stand-in for the Anthropic API, used only for local testing of the Worker.
// Run: node worker/test/mock-anthropic.mjs   (listens on :9999)
import http from 'node:http';
import fs from 'node:fs';

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.headers['x-api-key'] !== 'test-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":"bad key"}');
      }
      const body = JSON.parse(raw);
      fs.writeFileSync('/tmp/last-request.json', JSON.stringify({ model: body.model, system_blocks: body.system.length, cached_block: body.system.some((b) => b.cache_control), tool_choice: body.tool_choice, tool_ids: body.tools[0].input_schema.properties.matches.items.properties.service_id.enum.length, messages: body.messages.length }));
      const last = body.messages[body.messages.length - 1].content;
      const crisis = /crisis/i.test(last);
      const base = { status: 'results', urgent_support: false, urgent_types: [], pii_detected: false, understood_needs: ['mock need'], follow_up_questions: [] };
      const input = crisis
        ? { ...base, message: 'I am sorry you are going through this.', urgent_support: true, urgent_types: ['mental_health_crisis'], understood_needs: [], matches: [{ service_id: 'wellness-to-work', fit: 'strong', reason: 'should be dropped', check_first: '' }] }
        : {
            ...base,
            message: 'Mock reply.',
            matches: [
              { service_id: 'wellness-to-work', fit: 'strong', reason: 'Fits.', check_first: '' },
              { service_id: 'not-a-real-service', fit: 'strong', reason: 'Should be dropped.', check_first: '' },
              { service_id: 'wellness-to-work', fit: 'strong', reason: 'Duplicate, should be dropped.', check_first: '' },
              { service_id: 'fitness-for-work', fit: 'possible', reason: 'Also fits.', check_first: 'Check the health criteria.' },
            ],
          };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'respond', input }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  })
  .listen(9999, '127.0.0.1', () => console.log('mock anthropic on :9999'));
