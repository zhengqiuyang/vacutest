test('probe vacuous', () => {
  const m = makeMock();
  expect(m).toBeDefined();
});
function makeMock() { return {}; }
