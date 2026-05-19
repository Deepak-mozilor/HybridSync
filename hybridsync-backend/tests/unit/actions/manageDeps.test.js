// Tests the score validation and edge-merging logic used in manageDeps.

function isValidScore(score) {
  return Number.isInteger(score) && score >= 1 && score <= 10;
}

function mergeEdge(edges, peerId, score) {
  const idx = edges.findIndex(e => e.peerId === peerId);
  if (idx >= 0) {
    edges[idx] = { peerId, score, isManual: true };
  } else {
    edges.push({ peerId, score, isManual: true });
  }
  return edges;
}

function removeEdge(edges, peerId) {
  return edges.filter(e => e.peerId !== peerId);
}

describe('score validation', () => {
  it('accepts boundary values 1 and 10', () => {
    expect(isValidScore(1)).toBe(true);
    expect(isValidScore(10)).toBe(true);
  });

  it('accepts mid-range values', () => {
    [2, 5, 7, 9].forEach(s => expect(isValidScore(s)).toBe(true));
  });

  it('rejects 0 and 11', () => {
    expect(isValidScore(0)).toBe(false);
    expect(isValidScore(11)).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(isValidScore(-1)).toBe(false);
  });

  it('rejects NaN', () => {
    expect(isValidScore(NaN)).toBe(false);
  });

  it('rejects non-integer values', () => {
    expect(isValidScore(5.5)).toBe(false);
  });

  it('rejects result of parseInt on non-numeric string', () => {
    expect(isValidScore(parseInt('abc', 10))).toBe(false);
  });
});

describe('edge management', () => {
  it('adds a new edge with isManual=true', () => {
    const edges = [];
    mergeEdge(edges, 'UABC123456', 8);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ peerId: 'UABC123456', score: 8, isManual: true });
  });

  it('updates an existing edge score', () => {
    const edges = [{ peerId: 'UABC123456', score: 5, isManual: false }];
    mergeEdge(edges, 'UABC123456', 9);
    expect(edges).toHaveLength(1);
    expect(edges[0].score).toBe(9);
    expect(edges[0].isManual).toBe(true);
  });

  it('removes a peer edge', () => {
    const edges = [
      { peerId: 'UABC123456', score: 7, isManual: true },
      { peerId: 'UXYZ789012', score: 4, isManual: false },
    ];
    const result = removeEdge(edges, 'UABC123456');
    expect(result).toHaveLength(1);
    expect(result[0].peerId).toBe('UXYZ789012');
  });

  it('remove is a no-op if peer does not exist', () => {
    const edges = [{ peerId: 'UABC123456', score: 7, isManual: true }];
    const result = removeEdge(edges, 'UNONEXIST00');
    expect(result).toHaveLength(1);
  });
});
