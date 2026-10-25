const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  // A quote is a place to breathe: the reveal is slow and the motion is small.
  const mark = interpolate(frame, [0, fps * 0.5], [0, 1], { extrapolateRight: 'clamp' });
  const body = interpolate(frame, [fps * 0.3, fps * 1.1], [0, 1], { extrapolateRight: 'clamp' });
  const credit = interpolate(frame, [fps * 1.0, fps * 1.7], [0, 1], { extrapolateRight: 'clamp' });

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '0 20px',
    boxSizing: 'border-box',
  };
  // A rule rather than a “ glyph: the CJK quotation mark renders as two small
  // slashes in this face and reads as a typo.
  const markStyle = {
    width: 96 * mark,
    height: 6,
    borderRadius: 3,
    backgroundColor: p.accent,
    marginBottom: 34,
  };
  const bodyStyle = {
    marginTop: 18,
    fontFamily: p.displayFont,
    fontSize: p.fontSize,
    lineHeight: 1.42,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    color: p.ink,
    whiteSpace: 'pre-wrap',
    opacity: body,
    transform: 'translateY(' + ((1 - body) * 20) + 'px)',
  };
  const creditStyle = {
    marginTop: 34,
    fontFamily: p.bodyFont,
    fontSize: 30,
    letterSpacing: '0.16em',
    color: p.muted,
    opacity: credit,
  };

  return (
    <div style={rootStyle}>
      <div style={markStyle} />
      <div style={bodyStyle}>{p.text}</div>
      {p.author ? <div style={creditStyle}>{p.author}{p.source ? ' · ' + p.source : ''}</div> : null}
    </div>
  );
};
