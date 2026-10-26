import { Link } from 'react-router-dom';

/** The Amir SM mark: the Ethiopic character አ in a rounded-square monogram, plus the wordmark. */
export function Mark({ large }: { large?: boolean }) {
  return (
    <span className={`mark${large ? ' mark-lg' : ''}`} aria-hidden="true" lang="am">
      አ
    </span>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      Amir <span>SM</span>
    </span>
  );
}

export function Brand({ to }: { to?: string }) {
  const inner = (
    <>
      <Mark />
      <Wordmark />
    </>
  );
  return to ? (
    <Link className="brand" to={to} aria-label="Amir SM home">
      {inner}
    </Link>
  ) : (
    <span className="brand">{inner}</span>
  );
}
