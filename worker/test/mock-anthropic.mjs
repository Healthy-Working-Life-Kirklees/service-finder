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
      fs.writeFileSync('/tmp/last-request.json', JSON.stringify({ model: body.model, system_blocks: body.system.length, cached_block: body.system.some((b) => b.cache_control), tool_choice: body.tool_choice, tool_ids: body.tools[0].input_schema.properties.recommendations.items.properties.id.enum.length, messages: body.messages.length }));
      const last = body.messages[body.messages.length - 1].content;
      const crisis = /crisis/i.test(last);
      const input = crisis
        ? { message: 'I am sorry you are going through this.', recommendations: [{ id: 'wellness-to-work', why: 'should be dropped' }], safety_concern: true }
        : {
            message: 'Mock reply.',
            recommendations: [
              { id: 'wellness-to-work', why: 'Fits.' },
              { id: 'not-a-real-service', why: 'Should be dropped.' },
              { id: 'wellness-to-work', why: 'Duplicate, should be dropped.' },
              { id: 'fitness-for-work', why: 'Also fits.' },
            ],
            safety_concern: false,
          };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'respond', input }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  })
  .listen(9999, '127.0.0.1', () => console.log('mock anthropic on :9999'));
