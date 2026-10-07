export default function PostMatchActions({ ready, onNext, onStartOver }: {
  ready: boolean; onNext: () => void; onStartOver: () => void;
}) {
  return <div className="post-match-actions" aria-label="Continue match session">
    <p>Play again with the same pool, or start a fresh session.</p>
    <div>
      <button className="button button-primary" disabled={!ready} onClick={onNext} data-testid="button-next-match">Next Match</button>
      <button className="button button-secondary" disabled={!ready} onClick={onStartOver} data-testid="button-start-over">Start Over</button>
    </div>
  </div>;
}
