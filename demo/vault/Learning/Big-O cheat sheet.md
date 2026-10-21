# Big-O cheat sheet

How the work grows as the input size $n$ grows.

| Complexity | Example | 1,000 items |
|---|---|---|
| $O(1)$ | Array index | 1 step |
| $O(\log n)$ | Binary search | ~10 steps |
| $O(n)$ | Scanning a list | 1,000 steps |
| $O(n \log n)$ | Merge sort | ~10,000 steps |
| $O(n^2)$ | Comparing every pair | 1,000,000 steps |

Why binary search is $O(\log n)$: after $k$ halvings, $n / 2^k$ items remain, so

$$
k = \log_2 n
$$

```python
# O(n^2): every pair
for a in items:
    for b in items:
        compare(a, b)
```

- [x] Learn the common classes
- [ ] Practice spotting them in code
