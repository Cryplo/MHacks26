"""Real checkpoint verification: batch isolation, upstream parity, context rejection, timing."""
import json
import time
import laya_mlx
import numpy as np
from server import MODEL, REVISION, predict_batch

agent = laya_mlx.load(MODEL, revision=REVISION, dtype='float16')
question = {'type': 'choice', 'instructions': 'Predict the next action.', 'criteria': {'eat': 'Buy lunch at the cafe', 'ride': 'Join a roller coaster queue', 'rest': 'Sit on a shaded bench'}}
items = [{'state': f'A {state} guest has $35 remaining and 60 minutes until departure.', 'question': question} for state in ['hungry', 'exhausted', 'thrill-seeking']]
results = predict_batch(agent, items)
for item, result in zip(items, results):
    reference = agent.predict(item['state'], {'decision': question})['answers']['decision']['probabilities']
    assert np.allclose(list(result['probabilities'].values()), list(reference.values()), atol=0.002), (result, reference)
    assert abs(sum(result['probabilities'].values()) - 1) < 1e-5
try:
    predict_batch(agent, [{'state': 'hungry visitor ' * 3000, 'question': question}])
except ValueError as e:
    assert 'overflow' in str(e)
else:
    raise AssertionError('Silent truncation was accepted')
single = predict_batch(agent, [{'state': 'Only one permitted action remains.', 'question': {'type': 'choice', 'instructions': 'Select the permitted action.', 'criteria': {'leave': 'Leave the park'}}}])
assert single[0]['probabilities'] == {'leave': 1.0}
start = time.perf_counter()
for _ in range(5):
    predict_batch(agent, (items * 3)[:8])
elapsed = time.perf_counter() - start
print(json.dumps({'checkpoint': MODEL, 'revision': REVISION, 'batchVsSingleParity': True, 'overflowRejected': True, 'questions': 40, 'seconds': elapsed, 'questionsPerSecond': 40/elapsed}, indent=2))
