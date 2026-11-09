export function Stepper({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="stepper" aria-label="Progress" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
      {steps.map((label, i) => (
        <li key={label} className={i === current ? "current" : i < current ? "done" : ""} aria-current={i === current ? "step" : undefined}>
          <span className="dot">{i < current ? "✓" : i + 1}</span>
          <span className="label">{label}</span>
        </li>
      ))}
    </ol>
  );
}
