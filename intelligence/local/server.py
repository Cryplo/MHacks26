"""Loopback-only Laya service. Separate guest states share a forward pass, never a prompt.

Uses laya-mlx's Apache-2.0 prepare/collate/forward interfaces and its temperature
calibration. No generated prose or claimed reasoning. Model and port revisions are pinned.
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import laya_mlx
import numpy as np
from laya_mlx.agent import collate_items
from laya_mlx.common import temp_bucket

MODEL = 'aac6fef/laya-multilingual-mlx'
REVISION = 'f2b4faf51023039425946074e2cf1361d2db11d5'
MODEL_ID = 'laya-multilingual-mlx-f2b4faf5'
MAX_BATCH = 16
MAX_BODY = 262144


def predict_batch(agent, requests):
    if not isinstance(requests, list) or not 1 <= len(requests) <= MAX_BATCH:
        raise ValueError('Expected 1..16 independent requests')
    prepared, labels, diagnostics = [], [], []
    for request in requests:
        state, question = request['state'], request['question']
        if question.get('type') not in ('choice', 'score'):
            raise ValueError('Only choice and score are supported')
        if not 1 <= len(question['criteria']) <= 32:
            raise ValueError('Expected 1..32 options')
        items, _ = agent.prepare(state, {'decision': question})
        item = items[0]
        if item['state_stats']['state_tokens_dropped']:
            raise ValueError('Context overflow: refusing silently truncated guest state')
        if item['options']['options_distinct'] != item['options']['options']:
            raise ValueError('Option descriptions collide after tokenization')
        prepared.append(item)
        labels.append(list(question['criteria']) if question['type'] == 'choice' else [str(i) for i in range(len(question['criteria']))])
        diagnostics.append({'inputTokens': len(item['ids']), 'truncated': False})
    batch = collate_items(prepared, agent.tok.pad_token_id, max_length=agent.cfg.get('max_len', 1024))
    logits, _ = agent.forward(batch)
    logits = np.asarray(logits)
    if not np.isfinite(logits).all():
        raise ValueError('Non-finite inference output')
    results = []
    for row, (item, names, usage) in enumerate(zip(prepared, labels, diagnostics)):
        count, kind = len(names), item['qtype']
        scale = agent.temperature_by_options.get(temp_bucket(kind, count), agent.temperature[kind])
        scores = logits[row, :count] / scale
        probs = np.exp(scores - scores.max())
        probs /= probs.sum()
        results.append({'probabilities': dict(zip(names, map(float, probs))), 'confidence': float(probs.max()), **usage})
    return results


def main():
    print(json.dumps({'event': 'laya.loading', 'model': MODEL, 'revision': REVISION}), flush=True)
    agent = laya_mlx.load(MODEL, revision=REVISION, dtype='float16', batch_size=MAX_BATCH)
    # Warm up before publishing readiness.
    predict_batch(agent, [{'state': 'A hungry guest is near a cafe.', 'question': {'type': 'choice', 'instructions': 'What will the guest do?', 'criteria': {'a': 'Buy lunch', 'b': 'Rest'}}}])
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Request bodies are private observations, never access-log them.

        def send(self, status, body):
            data = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path != '/health':
                return self.send(404, {'error': 'Not found'})
            self.send(200, {'ready': True, 'model': MODEL_ID, 'checkpoint': MODEL, 'revision': REVISION})

        def do_POST(self):
            if self.path != '/predict':
                return self.send(404, {'error': 'Not found'})
            # A browser must not be able to submit cross-origin inference jobs.
            if self.headers.get('Origin'):
                return self.send(403, {'error': 'Browser requests are not accepted'})
            if self.headers.get_content_type() != 'application/json':
                return self.send(415, {'error': 'Expected application/json'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= MAX_BODY:
                    return self.send(413, {'error': 'Request too large or empty'})
                self.connection.settimeout(30)
                body = json.loads(self.rfile.read(size))
                if body.get('model') != MODEL_ID:
                    return self.send(400, {'error': 'Requested model does not match loaded checkpoint'})
                start = time.perf_counter()
                with lock:
                    results = predict_batch(agent, body['items'])
                self.send(200, {'model': MODEL_ID, 'checkpointRevision': REVISION, 'results': results, 'inferenceMs': (time.perf_counter()-start)*1000})
            except (ValueError, KeyError, TypeError) as error:
                self.send(422, {'error': str(error)})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                print(json.dumps({'event': 'laya.error', 'type': type(error).__name__}), flush=True)
                self.send(500, {'error': 'Local inference failed'})

    port = int(os.environ.get('LAYA_PORT', '4318'))
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    print(json.dumps({'event': 'laya.ready', 'port': port, 'model': MODEL_ID}), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
