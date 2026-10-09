export function PlaygroundPage() {
  return (
    <div style={{ maxWidth: 640, margin: '0 auto', textAlign: 'center', paddingTop: '4rem' }}>
      <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🧪</div>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f1f5f9', marginBottom: '0.5rem' }}>
        Agent Playground
      </h1>
      <p style={{ color: '#64748b', fontSize: '0.95rem', lineHeight: 1.6 }}>
        Coming soon. Test your agent with sample customer queries, inspect routing decisions,
        and validate policy gates before going live.
      </p>
      <div style={{
        marginTop: '2rem', background: '#1e2433', borderRadius: 12,
        padding: '1.5rem', border: '1px dashed #2d3748', color: '#475569', fontSize: '0.82rem',
      }}>
        Task #18 — Agent Playground (pending)
      </div>
    </div>
  )
}
