// The Ojuri monogram — the geometric "O." mark. Inline SVG so both circles
// pick up text color from the parent via currentColor, letting the same
// component work on light and dark surfaces without a variant prop.

export function Monogram({ size = 24, className, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Ojuri"
      className={className}
      {...rest}
    >
      <circle cx="11" cy="16" r="8" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="25" cy="23" r="3" fill="currentColor" />
    </svg>
  );
}
