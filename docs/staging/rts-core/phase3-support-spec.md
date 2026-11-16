# Stage 2 Phase 3 Spec: Special Units & Support Mechanics (Artillery, Aviation, Logistics & Replenishment)

> **Status**: **Directional Baseline** under `stage:2-rts-core` (Master Issue `#4`).  
> **Rolling-Wave Planning Note**: Per Stage 2 governance, this specification defines the directional mechanics and interfaces connecting special units and support systems to Phases 1–2 (`phase1-map-spec.md`, `phase2-combat-spec.md`), and will be re-evaluated before dispatching Phase 3 implementation sub-issues.

---

## 1. Artillery & Indirect Fire Support (`Artillery & Ranging Mechanics`)

### 1.1 Artillery Ammo Types (`ArtilleryAmmoType`)
```ts
export type ArtilleryAmmoType =
  | "HE_Impact"
  | "HE_Airburst"
  | "Smoke"
  | "Direct_Self_Defense";
```

1. **`HE_Impact` (Contact-Fuze High Explosive)**:
   * Evaluated using Phase 2's isotropic inverse-square `KE` penetration model across all 4 directional armor zones:
     $$\text{Pen}_{\text{HE}}(d_z) = \frac{\text{Pen}_{\text{contact}}}{1 + (d_z / d_0)^2}$$
2. **`HE_Airburst` (Airburst-Fuze High Explosive)**:
   * Contact penetration is halved ($0.5 \times \text{Pen}_{\text{contact}}$), while the blast attenuation reference radius is multiplied by **5×** ($d_0^{\text{airburst}} = 5 \times d_0$).
   * **Hard Calibration Requirement**: Requires at least **1 valid ranging round (`试射`)**; otherwise the time/proximity fuze fails to set accurately and automatically degrades to `HE_Impact`.
3. **`Smoke`**:
   * Carries an intrinsic **2× accuracy bonus** (dispersion radius halved) and **requires no ranging rounds** (transitions straight to Fire for Effect).
   * On impact, spawns dynamic smoke occlusion volumes that add optical extinction $\mu_{\text{smoke}}$ into Phase 1's 3D Beer-Lambert `sightline()` attenuation path.
4. **`Direct_Self_Defense` (`APFSDS` / `HEAT` / `Canister`)**:
   * Self-defense rounds fired by capable self-propelled artillery are resolved identically to Phase 2 direct-fire weapons.

### 1.2 Ranging (`试射`), Observer Calibration & Registration Tactics
* **Default Ranging Cycle**:
  * When a friendly **Observer (`hasObserver`)**—present in recon vehicles, recon squads, or standard infantry squads—has active sight of the target area, the battery conducts **2 ranging rounds** by default (single gun firing; each round doubles accuracy / halves dispersion radius) before commencing full-battery **Fire for Effect (FFE)**.
* **Unobserved / Blind Fire**:
  * If no friendly Observer can observe the target zone, the battery skips ranging and immediately enters uncalibrated **FFE** (and any `HE_Airburst` mission automatically degrades to `HE_Impact`).
* **Battery Position Calibration & Registration Point Tactic (`炮位系统误差消除 & 放空炮校射`)**:
  * Completing ranging eliminates the firing battery's systematic position error (`isPositionCalibrated = true`), granting a persistent partial accuracy bonus when shifting fire to subsequent targets from the **same firing position**.
  * Displacing / moving the battery immediately resets `isPositionCalibrated` to `false`.
  * *Tactical Emergent Behavior*: Batteries may intentionally fire ranging rounds at an observer-visible **registration point (`放空炮`)** to calibrate the firing position, then shift fire onto an unobserved target to retain the position-calibration bonus.
* **MLRS (`Rocket Artillery`) Exception**:
  * Multiple Launch Rocket Systems cannot be observer-calibrated and never fire ranging rounds; they always execute uncalibrated area FFE.

---

## 2. Fixed-Wing Air Support (`Fixed-Wing Aviation`)

### 2.1 Airspace Scale & Transit Interception
* **2× Linear / 4× Area Air Theater**: The fixed-wing airspace extends to **2× the linear dimensions (4× total area)** of the ground battlefield (e.g., an `8 km × 8 km` air box centered over a `4 km × 4 km` ground map).
* Aircraft transiting through the outer air ring to and from the ground combat zone can be detected, damaged, or suppressed by **Area Air Defense**, or intercepted in **air-to-air dogfights**—potentially forcing an abort before reaching the target.

### 2.2 Altitude Selection (`FlightAltitude`)
```ts
export type FlightAltitude = "low" | "high";
```
Determined autonomously by the aircraft bot upon ingress:
* **`low` (Low-Altitude Ingress)**: Reduces detection and interception risk from long-range Area Air Defense, at the cost of higher exposure to short-range air defense (**SHORAD**).
* **`high` (High-Altitude Ingress/CAP)**: Greatly reduces SHORAD hit probability and grants an **Energy Advantage** in air-to-air engagements, at the cost of high exposure to Area Air Defense.

### 2.3 Sortie Economy, Fuel & Three-Part Turnaround
* **Cost & Turnaround**: Requisitioning a fixed-wing aircraft incurs a unit cost; post-sortie turnaround is free and tracked by three independent timers: **`refuelTime`**, **`repairTime`**, and **`rearmTime`**.
* **Fuel & Mission Profiles**: Base fuel capacity is generous, allowing mission-appropriate **Loiter / CAP** orbits or **Auto-Egress** after weapon release. Entering air-to-air combat engages **Afterburner** (if equipped), sharply increasing fuel consumption.
* **Stress Abort**: Excessive pilot stress/suppression causes the aircraft to abort its task and egress early, entering normal turnaround.

*(Note: Electronic Warfare [EW] and SEAD / Anti-Radiation mechanics are deferred to future stages.)*

---

## 3. Helicopters (`Rotary-Wing Aviation`)

### 3.1 Ingress/Egress & Endurance
* Helicopters enter and exit directly along the **ground battlefield edges** (no outer-airspace transit delay) and operate with **no fuel limit**.

### 3.2 Rearm & Repair Constraints
* **FOB Full Turnaround**: Helicopters must **land inside FOB coverage** to receive ammunition resupply (**`rearm`**) and full structural repair (**`100%` HP**).
* **Field Supply Vehicle Cap**: Mobile supply units can repair a landed helicopter up to a **`50%` HP ceiling**, and **cannot resupply helicopter ammunition**.

### 3.3 Forced Landing (`< 30% HP`) vs. Shootdown & Field Recovery
* When a helicopter drops below **`30%` HP**, it loses lift and enters descent:
  * **Forced Landing (`迫降`)**: If remaining HP stays above `0` (not depleted by burst/overkill damage), there is a high probability of executing a forced landing—embarked infantry immediately evacuate (sharing incoming damage and suppression during descent/landing), and the disabled hull remains on the ground.
  * **Field Recovery**: If a Supply Vehicle repairs a forced-landed helicopter up to a flyable threshold (within the `50%` field repair cap), it can **take off again and fly back to the FOB** for full restoration and rearming.
  * **Destroyed**: Rapid HP depletion to `0` or heavy overkill destroys the helicopter outright.

### 3.4 Transport
* Helicopters can land on `open` terrain to embark/disembark infantry or cargo supplies; like ground transports, embarked infantry share a portion of damage and suppression taken by the airframe.

---

## 4. Logistics (`FOB` vs. `Supply Vehicles`) & Infantry Replenishment (`WIA` vs. `KIA`)

### 4.1 Two-Tier Supply Network
1. **`FOB` (Forward Operating Base)**:
   * Immobile structure with **infinite supply generation**, high transfer efficiency, and **extra damage/suppression resistance against artillery bombardment** (for gameplay balance).
2. **`Supply Vehicle` (Supply Trucks, Logistics APCs, Cargo Helicopters)**:
   * **Enters the battlefield empty (`0` supply)**; must travel to a friendly `FOB` to load supplies before distributing ammunition and field repairs at the front.

### 4.2 Infantry Casualties (`WIA` vs. `KIA`) & Three-Way Recovery
Building on Phase 2's `InfantrySubRoster`, infantry losses are partitioned into two medical states:

1. **`WIA` (Wounded / Incapacitated — majority of non-lethal hits)**:
   * Temporarily combat-ineffective (cannot man weapons), recoverable via three paths:
     * **Out-of-Combat Self-Aid (`脱战自愈`)**: Units out of active combat slowly heal `WIA` personnel on their own, at a much slower rate than FOB/Supply healing and bounded by a **self-recovery ceiling (`回血上限`)**.
     * **Supply Vehicle Recovery**: Consumes carried supply to gradually restore `WIA` personnel at the front.
     * **FOB Medical Recovery**: Rapidly heals `WIA` personnel while stationed at the FOB (note: staying at a FOB heals `WIA`, not `KIA`).
2. **`KIA` (Killed in Action — minority of hits or severe lethal damage)**:
   * **Cannot be healed on the battlefield** (neither by Supply Vehicles nor at a FOB).
   * To replenish `KIA` losses, the infantry unit must **withdraw off the ground map edge (`离开地图`) as an intact formation**, pay a reinforcement cost, and return after a reconstitution cooldown with **veterancy/experience preserved** and **ammunition and morale reset**.
