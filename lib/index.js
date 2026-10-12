/**
 * Host half of dsh-plugin-tianyicui-monitor.
 *
 * The package's user-visible behaviour lives entirely in the browser half
 * (`./client`): the top-left entry, the panel, the charts, and the probability.
 * This entry exists so the package is an ordinary Loader row whose `dsh.client`
 * declaration the host scans to build the browser bundle graph.
 *
 * It deliberately provides no Cordis service, registers no tool, and imports
 * nothing, so mounting it costs only the row itself and the file stays valid
 * wherever the package is installed. The Node-side GitHub reader lives in the
 * repository at `src/host/source.js` for offline use; it is not part of the
 * shipped install and nothing at runtime depends on it.
 */
export function apply() {
  // No registration on purpose: the browser half owns every contribution.
}
