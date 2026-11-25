import re

with open('ui-only/under_construction_site_dashboard.html', 'r', encoding='utf-8') as f:
    text = f.read()

# Pattern matching for the top-right crane SVG badge in Section 1
old_badge_regex = re.compile(
    r'<!-- TOP-RIGHT INTERACTIVE TOWER CRANE TELEMETRY NODE.*?</svg>\s*</div>',
    re.DOTALL
)

new_badge = '''<!-- REAL CRANE MODEL CARD & LIVE SLEWING ROTOR (Matches User Physical Scale Model) -->
          <div class="relative group cursor-pointer shrink-0 z-20" title="Physical Scale Model Crane - Click to view in full HD" onclick="openCranePhotoModal()">
            <div class="relative w-20 h-20 sm:w-24 sm:h-24 lg:w-28 lg:h-28 rounded-2xl p-1 border-2 sm:border-[3px] border-[#FFE600] bg-black/60 shadow-[0_0_30px_rgba(255,230,0,0.6)] flex items-center justify-center overflow-hidden transition transform hover:scale-105">
              <!-- Real Photo of Actual Scale Model Crane -->
              <img src="crane_model_reference.jpg" alt="Real Scale Model Crane" class="w-full h-full object-cover rounded-xl border border-[#FFE600]/50" />
              <!-- Glass Gradient Overlay with Live Status Tag -->
              <div class="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/30 rounded-xl pointer-events-none"></div>
              <div class="absolute bottom-1 inset-x-1 flex items-center justify-center">
                <span class="px-1.5 py-0.5 rounded bg-[#FF3D00] text-[#FFE600] font-black text-[9px] sm:text-[10px] tracking-wider uppercase shadow">REAL CRANE</span>
              </div>
              <!-- Live Rotating Jib Telemetry Radar Overlay (Pivoting dynamically in real time) -->
              <svg class="absolute top-1 right-1 w-7 h-7 sm:w-8 sm:h-8 pointer-events-none" viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="18" fill="rgba(0,0,0,0.65)" stroke="#FFE600" stroke-width="1.5"/>
                <g id="miniCraneJibGroup" transform="rotate(212.7 20 20)">
                  <line x1="20" y1="20" x2="20" y2="4" stroke="#FFE600" stroke-width="3" stroke-linecap="round"/>
                  <polygon points="20,2 17,7 23,7" fill="#FF3D00"/>
                  <line x1="20" y1="20" x2="20" y2="30" stroke="#FF6D00" stroke-width="2.5" stroke-linecap="round"/>
                  <rect x="17" y="27" width="6" height="5" rx="1" fill="#FFE600"/>
                </g>
                <circle cx="20" cy="20" r="2.5" fill="#FFE600"/>
              </svg>
            </div>
          </div>'''

match = old_badge_regex.search(text)
if not match:
    print("ERROR: old_badge_regex did not match!")
    exit(1)

text = text[:match.start()] + new_badge + text[match.end():]

# Update JS pivot for miniJib
text = text.replace(
    "miniJib.setAttribute('transform', `rotate(${telemetry.jibAngle.toFixed(1)} 50 34)`);",
    "miniJib.setAttribute('transform', `rotate(${telemetry.jibAngle.toFixed(1)} 20 20)`);"
)

# Photo Modal HTML
photo_modal = '''  <!-- REAL CRANE PHOTO HD MODAL -->
  <div id="cranePhotoModal" class="fixed inset-0 z-50 bg-black/90 backdrop-blur-md hidden flex items-center justify-center p-4">
    <div class="relative max-w-2xl w-full bg-[#1A1810] border-2 border-[#FFE600] rounded-2xl p-4 shadow-[0_0_50px_rgba(255,230,0,0.5)] flex flex-col items-center">
      <div class="w-full flex items-center justify-between pb-3 border-b border-[#FFE600]/40">
        <div class="flex items-center gap-2">
          <span class="w-3 h-3 rounded-full bg-[#39FF14] animate-ping"></span>
          <span class="text-[#FFE600] font-black text-lg tracking-wider">PHYSICAL SCALE MODEL CRANE</span>
        </div>
        <button onclick="closeCranePhotoModal()" class="px-4 py-1 rounded-lg bg-[#FF1744] hover:bg-[#D50000] text-white font-bold text-sm tracking-wider uppercase transition">✕ CLOSE</button>
      </div>
      <div class="my-4 w-full flex items-center justify-center rounded-xl overflow-hidden border border-[#FFE600]/40 bg-black">
        <img src="crane_model_reference.jpg" alt="Physical Scale Model Crane" class="max-h-[70vh] w-auto object-contain" />
      </div>
      <div class="w-full flex items-center justify-between text-xs sm:text-sm text-[#FFE600] font-mono">
        <span>TESTBED MODEL: ORANGE TOWER CRANE</span>
        <span>STATUS: LIVE STREAM ROTATION ACTIVE</span>
      </div>
    </div>
  </div>

  <script>
    function openCranePhotoModal() {
      document.getElementById('cranePhotoModal').classList.remove('hidden');
    }
    function closeCranePhotoModal() {
      document.getElementById('cranePhotoModal').classList.add('hidden');
    }
  </script>
'''

if 'id="cranePhotoModal"' not in text:
    text = text.replace('</body>', photo_modal + '\n</body>')

with open('ui-only/under_construction_site_dashboard.html', 'w', encoding='utf-8') as f:
    f.write(text)

print("SUCCESS: Embedded real crane model photo into dashboard!")

