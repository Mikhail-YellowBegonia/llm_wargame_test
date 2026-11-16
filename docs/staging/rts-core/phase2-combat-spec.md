# Stage 2 Phase 2 Spec: Core Combat Mechanics (Spotting, Armor, Morale & Squad/Vehicle Patches)

> **Status**: **Directional Baseline** under `stage:2-rts-core` (Master Issue `#4`).  
> **Rolling-Wave Planning Note**: Per Stage 2 governance, this specification establishes the core combat interfaces and mechanical rules to align with Phase 1 (`phase1-map-spec.md`), and will be re-evaluated before dispatching concrete Phase 2 implementation sub-issues.

---

## 1. Spotting, Concealment & Two-Tier Detection (`Contact` vs. `Visual`)

### 1.1 Deterministic Instantaneous Threshold
All spotting checks are **instantaneous and deterministic** (no RNG spotting dice or spotting progress bars). Each tick, detection is evaluated against the Phase 1 unified 3D Beer-Lambert + linear distance equation:
$$D \le (R_{\text{optics}}(O) \cdot S) \cdot \mathcal{T}_{O \to E}$$

### 1.2 Decoupled Target Signatures
Target observability is split into two independent signature channels:

1. **`bodySignature` ($S_{\text{body}}$)** — governs **`Visual`** detection of the physical unit:
   * Base value derives from unit type, Phase 1 terrain `baseSignature`, and `UnitTrait`-specific `signatureMult`.
   * **Movement**: Moving raises $S_{\text{body}}$ ($M_{\text{move}} > 1$).
   * **Settled Infantry**: Stationary infantry settled for a continuous duration $T_{\text{settle}}$ (in terrain cover or garrisoned inside buildings) receives a slight concealment bonus ($M_{\text{settled}} < 1$).
   * **Cowering (`Shaken`+)**: Units under high pressure (`Shaken` or worse) hug cover/ground, reducing $S_{\text{body}}$ ($M_{\text{cower}} < 1$).

2. **`muzzleSignature` ($S_{\text{muzzle}}$)** — governs **`Contact`** detection when firing:
   * Firing a weapon **does not** increase the unit's own `bodySignature`.
   * Instead, each fired weapon $W$ produces an instantaneous muzzle signature $S_{\text{muzzle}}(W)$ tagged with a coarse signature class:
     ```ts
     export type WeaponSignatureClass = "small_arms" | "light_weapon" | "heavy_weapon";
     ```
   * Higher signature classes override lower ones (`heavy_weapon` > `light_weapon` > `small_arms`).

### 1.3 Two-Tier Detection Levels (`Contact` vs. `Visual`)
```ts
export type DetectionLevel = "contact" | "visual";
```

1. **`Visual`**:
   * Triggered when an observer $O$ satisfies the threshold against the target's body:
     $$D \le (R_{\text{optics}}(O) \cdot S_{\text{body}}(E)) \cdot \mathcal{T}_{O \to E}$$
   * Reveals **exact position** and **accurate unit type/identity**, regardless of whether the target is firing.
2. **`Contact`**:
   * Assigned when the target does **not** meet `Visual` for any friendly observer, **but** either:
     * Observer $O$ detects the weapon's firing flash:
       $$D \le (R_{\text{optics}}(O) \cdot S_{\text{muzzle}}(W)) \cdot \mathcal{T}_{O \to E}$$
     * **OR** a friendly unit takes HP damage or suppression from that enemy unit.
   * Reveals **position** and the highest observed `WeaponSignatureClass` (`small_arms`, `light_weapon`, or `heavy_weapon`), **without** revealing specific unit type.

*(Note: Type-ambiguity / misidentification models and additional sensor channels such as radar, anti-radiation, or IR are deferred to future iterations.)*

---

## 2. Direct Fire, Armor/Penetration & Weapon Envelopes

### 2.1 Three-Tier Own-Optics Direct-Fire Accuracy Rule (`Own-Optics Patch`)
Direct fire always requires a physically unobstructed line of fire, and its accuracy scales strictly by the **firing unit's own optics** perception of the target (`ownPerception`):
* Friendly reconnaissance units can spot targets to grant accuracy bonuses to **indirect fire**, whereas **direct-fire** units must acquire targets with their own sights for full precision.

| Tier | Firing Unit's Own Perception | Friendly Shared Knowledge | Accuracy Rule |
| :--- | :--- | :--- | :--- |
| **Tier 1** | `ownPerception === "none"` | `Contact` or `Visual` via friendly recon/allies | **Heavy Accuracy Penalty** (suppressive/area fire at relayed coordinates) |
| **Tier 2** | `ownPerception === "contact"` | May be `Contact` or `Visual` via friendlies | **Small/Moderate Accuracy Penalty** (engaging observed muzzle flash / firing source) |
| **Tier 3** | `ownPerception === "visual"` | `Visual` | **No Accuracy Penalty** (`100%` baseline gunnery accuracy) |

### 2.2 Directional Dual-Protection Armor (`ArmorProfile`) & Building Resistance
Every unit defines four directional armor zones (`front`, `side`, `rear`, `top`), each storing Kinetic (`ke`) and Chemical (`ce`) armor thickness:

```ts
export interface ArmorValue {
  ke: number;
  ce: number;
}

export interface ArmorProfile {
  front: ArmorValue;
  side: ArmorValue;
  rear: ArmorValue;
  top: ArmorValue;
}
```

* **Building Structural Resistance**: Buildings also define `{ ke: number; ce: number }` resistance ratings. Any hit failing to penetrate a building's armor deals **`0` damage** to the targeted floor's `integrity` (HP).

### 2.3 Ammo Archetypes (`AP` / `HEAT` / `HE`) & Non-Penetration Rule
```ts
export type AmmoType = "AP" | "HEAT" | "HE";
```

* **`AP` (Kinetic)**: Compares distance-scaled kinetic penetration against the impacted zone's `ke` armor.
* **`HEAT` (Chemical)**: Compares fixed chemical penetration against the impacted zone's `ce` armor.
* **`HE` Inverse-Square Patch**:
  * Evaluated against **`ke` armor**.
  * Because blast overpressure/fragmentation propagates isotropically from the detonation center, compute the distance $d_z$ from the blast center to the nearest point on each of the target's 4 armor zones (`front`, `side`, `rear`, `top`).
  * Penetration at zone $z$ follows the contact-clamped inverse-square law:
    $$\text{Pen}_{\text{HE}}(d_z) = \frac{\text{Pen}_{\text{contact}}}{1 + (d_z / d_0)^2}$$
  * If **any** of the 4 zones satisfies $\text{Pen}_{\text{HE}}(d_z) \ge \text{Armor}_{\text{KE}}(z)$, the target suffers penetration.
* **Non-Penetration Feedback**:
  * Hits that fail to penetrate armor inflict **`0` HP/strength damage** and deal **suppression only** (which, because no damage is caused, cannot push morale past the Suppression Floor).

### 2.4 Multi-Weapon Concurrency
* **Vehicles**: By default, vehicles can fire all available weapons concurrently. Hardware exclusions are modeled via an optional `mutexGroup` tag on weapon slots (e.g., BMP-3 locking its coaxial `30mm` autocannon while its `100mm` main gun performs fixed-elevation reloading).
* **Infantry**: Each individual soldier can operate only **1 weapon at a time**, while a squad or platoon simultaneously employs rifles, machine guns, and anti-tank launchers across its surviving members (governed by Section 4.1).

---

## 3. Four-Tier Morale, Suppression & Cowering

### 3.1 Morale Tiers & Passive Recovery
Morale progresses through four tiers with gradual passive recovery when out of heavy pressure:
```ts
export type MoraleTier = "calm" | "worried" | "shaken" | "panicked";
```

* **Suppression Floor**: Morale drain caused purely by suppression is capped at **the midpoint of `shaken`**. Morale levels below the midpoint of `shaken` (down to `panicked`) can only be induced by **actual HP/strength damage** or **unbounded special events** (`Artillery Shock Penalty`).

### 3.2 Combat Degradation & Cowering (`Shaken`+)
* As morale worsens, accuracy, rate of fire, and movement speed all degrade.
* Upon entering **`shaken`** or **`panicked`**, the unit enters **Cowering (`畏缩`)**:
  * `bodySignature` decreases (harder to spot visually),
  * `optics` range decreases (tunnel vision / heads down),
  * Defensive cover bonus (`damageMult` reduction) increases.
* **Suppression Resistance**: Scales positively with the current terrain/building's damage reduction (`1 - damageMult`), reflecting troop confidence in hard cover.

### 3.3 Four Morale Events
1. **Supply Bonus**: Rapid morale recovery while inside the radius of a **FOB** or **supply vehicle**.
2. **Combat Feat Bonus**: Extra morale recovery when friendly units score actual combat results within a recent window (**actual HP damage dealt only**; pure suppression does not count).
3. **Isolation Penalty**: When actively engaged in combat and visible enemies in LoS heavily outnumber friendlies, morale suffers continuous drain down to a floor at **the midpoint of `worried`**.
4. **Artillery Shock Penalty**: When unarmored targets in open terrain are caught within blast range of `HE` artillery rounds, they suffer heavy suppression and morale shock scaled by explosive yield—**with no lower bound** (capable of driving morale directly to `panicked`).

---

## 4. Infantry Takeover & Vehicle Patches

### 4.1 Infantry Personnel/Weapon Takeover Patch (`InfantrySubRoster`)
To avoid artificial squad invalidation when a specific gunner falls (e.g., an ATGM team losing its missile capability on the first casualty), infantry units separate **soldier specialties** from **carried equipment**:

```ts
export type SpecialistRole =
  | "rifleman"
  | "mg_specialist"
  | "at_specialist"
  | "marksman"
  | "engineer";

export interface InfantryWeaponSlot {
  id: string;
  isSpecial: boolean;
  requiredRole?: SpecialistRole;
  abandonPriority: number; // Lower value = retained longer (e.g., ATGM = 1, MG = 2, RPG = 3, Rifle = 99)
}

export interface InfantrySubRoster {
  personnel: Record<SpecialistRole, number>; // Living headcount per specialty
  weapons: InfantryWeaponSlot[];           // Equipment pool (max 2 weapons carried per soldier: 1 primary + 1 special)
}
```

#### Four Casualty Takeover Rules
1. **Specialist Priority**: At full strength, each weapon is manned by its matching `requiredRole` specialist with zero penalty.
2. **Retain Special Weapons**: When casualties reduce headcount below total weapon slots, **standard primary weapons (rifles) are dropped first**; special weapons are retained as long as enough soldiers survive (up to 1 primary + 1 special carried per soldier, firing 1 at a time).
3. **Cross-Manning with Debuff**: If no specialist remains for a special weapon, another surviving soldier takes it over, incurring an **`unskilledPenalty`** (reduced accuracy / reload speed).
4. **Priority Abandonment**: If surviving headcount falls below the count of special weapons, excess special weapons are abandoned in ascending priority order (`abandonPriority`).

### 4.2 Vehicle Minor Patches (Progressive Implementation)
1. **Stuck-Recovery Pivot**: Wheeled vehicles are permitted to pivot in place as a fallback if pathfinding becomes wedged.
2. **Firing Ports / Embarked Fire**: Infantry embarked in designated APCs/IFVs (e.g., M113, BTR/BMP) may fire outward with restricted range and accuracy.
3. **Damage & Suppression Bleed-Through**: Under appropriate hit/penetration conditions, a fraction of damage and suppression inflicted on a transport vehicle transfers to its embarked infantry.
