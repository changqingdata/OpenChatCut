const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;
  // The recipe is designed at 1080 wide and is handed the whole canvas, so
  // every fixed pixel value below is a design value. Without this factor a
  // 1920-wide landscape frame keeps the 1080 sizes and the word looks small in
  // a frame that is 1.8× bigger.
  const k = item.width / 1080;

  // A slam: it arrives oversized and settles, rather than growing into place.
  const enter = spring({ frame, fps, config: { damping: 18, mass: 0.7, stiffness: 150 } });
  const scale = 1.24 - 0.24 * enter;
  const opacity = Math.min(1, enter * 2.2);
  const glow = interpolate(frame, [0, fps * 0.8], [0.22, 0], { extrapolateRight: 'clamp' });

  // Two characters at 620px each is 1240px in a 1080px box: the outer strokes
  // get cropped. So the size is capped by width, and then by height — the
  // frame is 1080 tall in landscape, and a width-only cap let a two-character
  // word grow to 864px and sit on top of the burned-in captions.
  const glyphs = Array.from(String(p.text ?? ''));
  const perGlyph = glyphs.length > 0 ? (item.width / glyphs.length) * 0.9 : p.fontSize;
  // Leave the bottom band alone: burned-in captions occupy the last ~16%, and
  // the recipe's own caption needs a line under the word.
  const roomForWord = item.height * (p.caption ? 0.5 : 0.62);
  const size = Math.min(p.fontSize * k, perGlyph, roomForWord);

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };
  const wordStyle = {
    fontFamily: p.displayFont,
    fontSize: size,
    // 0.86 collided: a 760px em box in a 654px line box overlapped the line above.
    lineHeight: 1.0,
    fontWeight: 400,
    letterSpacing: p.tracking,
    color: p.ink,
    textAlign: 'center',
    transform: 'scale(' + scale + ')',
    opacity: opacity,
    textShadow: '0 0 ' + (60 * k * glow) + 'px ' + p.accent,
  };
  // Flow below the word instead of pinning to a bottom offset: with the word
  // sized from the frame, a fixed offset lands inside the glyphs.
  const captionStyle = {
    marginTop: item.height * 0.035,
    textAlign: 'center',
    fontFamily: p.bodyFont,
    fontSize: 34 * k,
    letterSpacing: '0.3em',
    color: p.muted,
    opacity: interpolate(frame, [fps * 0.4, fps * 1.0], [0, 1], { extrapolateRight: 'clamp' }),
  };

  return (
    <div style={rootStyle}>
      <div style={wordStyle}>{p.text}</div>
      {p.caption ? <div style={captionStyle}>{p.caption}</div> : null}
    </div>
  );
};
