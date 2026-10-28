const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;
  // Wide canvas: centred and larger. A left-aligned measure that is right for a
  // 900px card leaves two thirds of a 1920px frame empty, and at the portrait
  // size the line breaks wherever it runs out of width rather than where the
  // sentence wants to pause.
  const wide = p.landscape === true;

  // A quote is a place to breathe: the reveal is slow and the motion is small.
  const mark = interpolate(frame, [0, fps * 0.5], [0, 1], { extrapolateRight: 'clamp' });
  const body = interpolate(frame, [fps * 0.3, fps * 1.1], [0, 1], { extrapolateRight: 'clamp' });
  const credit = interpolate(frame, [fps * 1.0, fps * 1.7], [0, 1], { extrapolateRight: 'clamp' });

  // Fit the type to the sentence instead of fixing it: a 12-character line and a
  // 32-character line should both fill the card. Two lines is the target on a
  // wide canvas — one long line reads as a ticker, four reads as a paragraph.
  const chars = Array.from(String(p.text ?? '')).length || 1;
  const perLine = chars <= 12 ? chars : Math.ceil(chars / 2);
  const inner = item.width * 0.86;
  const fit = Math.floor((inner / perLine) * 0.95);
  // Portrait keeps its authored size and simply wraps; the fit is what makes a
  // wide card use its width instead of breaking the sentence in half.
  const size = wide ? Math.min(Math.round(p.fontSize * 1.6), fit) : p.fontSize;

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: wide ? 'center' : 'stretch',
    textAlign: wide ? 'center' : 'left',
    padding: wide ? '0 7%' : '0 20px',
    boxSizing: 'border-box',
  };
  // A rule rather than a “ glyph: the CJK quotation mark renders as two small
  // slashes in this face and reads as a typo.
  const markStyle = {
    width: (wide ? 120 : 96) * mark,
    height: 6,
    borderRadius: 3,
    backgroundColor: p.accent,
    marginBottom: wide ? 44 : 34,
  };
  const bodyStyle = {
    marginTop: 18,
    fontFamily: p.displayFont,
    fontSize: size,
    lineHeight: wide ? 1.34 : 1.42,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    color: p.ink,
    whiteSpace: 'pre-wrap',
    // 20 characters at 58px in an 860px card wraps as 19 + 1, leaving a single
    // orphan character on the second line. Balance the lines instead.
    textWrap: 'balance',
    opacity: body,
    transform: 'translateY(' + ((1 - body) * 20) + 'px)',
  };
  const creditStyle = {
    marginTop: wide ? 42 : 34,
    fontFamily: p.bodyFont,
    fontSize: wide ? 34 : 30,
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
