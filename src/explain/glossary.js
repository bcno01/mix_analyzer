// 画面の「指標の見方」に並べる項目の定義。文言は i18n（g.<id>.what / g.<id>.guide / how.*）。
export const GLOSSARY_GROUPS = [
  { id: 'loudness', ids: ['integrated', 'lra', 'truePeak', 'samplePeak', 'momMax', 'stMax', 'clip'] },
  { id: 'dynamics', ids: ['plr', 'crest', 'rms'] },
  { id: 'stereo', ids: ['corr', 'side'] },
];

/** グラフの見方（見出しキー 'how.<id>.head' と本文キー 'how.<id>'）。 */
export const CHART_GUIDES = ['freq.third', 'freq.seven', 'st.gonio', 'st.sm', 'st.corr', 'time.corr', 'time.crest'];
