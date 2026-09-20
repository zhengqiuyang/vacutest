test('empty placeholder', () => {});

test('no assertions here', () => {
  const x = compute();
  console.log(x);
});

test('always true', () => {
  expect(true).toBe(true);
});

test('weak only', () => {
  const r = compute();
  expect(r).toBeDefined();
});

test('silent catch', () => {
  try {
    compute();
  } catch {}
});

test('static snapshot', () => {
  const mockUser = { id: 1 };
  expect(mockUser).toMatchSnapshot();
});

function compute() {
  return 42;
}
