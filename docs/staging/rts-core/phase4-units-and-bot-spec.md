# Stage 2 Phase 4 Spec: Standard Units, Minimal OOB & AI-Ready Bot Architecture

> **Status**: **Directional Baseline** under `stage:2-rts-core` (Master Issue `#4`).  
> **Rolling-Wave Planning Note**: Per Stage 2 governance, this document defines the directional unit roster and bot decoupling architecture connecting Phases 1–3 mechanics to Stage 3 AI integration, and will be re-evaluated before dispatching Phase 4 implementation sub-issues.

---

## 1. Minimal Complete Archetype Roster (`Symmetric-Asymmetric OOB`)

### 1.1 Roster Policy & Simulation Granularity
* **One Archetype Per Role**: Provide one representative unit archetype per tactical/support role rather than exhaustive faction encyclopedias, prioritizing numerical balance tuning and full coverage of Phases 1–3 mechanics.
* **Symmetric-Asymmetric Design**: Blue (`NATO`) and Red (`Pact`) share broadly symmetric roles with subtle doctrinal/equipment differences.
* **Hierarchical Granularity Extensibility**: Initial simulation granularity operates at the **Platoon / Section** level, while underlying data structures (`InfantrySubRoster`, `headcount`, per-weapon slots) are structured to support progressive refinement down to **Squad** or **Individual Soldier** fidelity without architectural breakage.

### 1.2 Core Unit Archetypes (11 Functional Categories)

| Category | Core Mechanics Covered (Phases 1–3) | Blue Example (NATO) | Red Example (Pact) |
| :--- | :--- | :--- | :--- |
| **`MBT`** (Main Battle Tank) | Directional `ke`/`ce` `ArmorProfile`, `AP`/`HE` direct fire, `Smoke` self-defense | M1A1 Abrams | T-80BV |
| **`IFV / APC`** (Mechanized Transport) | Embarked troop firing ports, damage/suppression bleed-through, weapon `mutexGroup` (e.g., BMP-3) | M2A2 Bradley / M113 | BMP-2 / BMP-3 |
| **`Line Infantry`** | Decoupled `InfantrySubRoster` & casualty takeover, building garrison (`headcount`/`capacity`), `WIA`/`KIA`, `hasObserver` | Mech. Infantry Platoon | Mot. Rifle Platoon |
| **`ATGM Section`** | Long-range `HEAT`, `low_profile` concealment, upper-floor building vantage | TOW-2 Section | Konkurs Section |
| **`Recon`** (Scout Team / Vehicle) | High `optics`, stealth, artillery `Ranging` calibration (`hasObserver`) | Recon Squad / Luchs | Spetsnaz / BRDM-2 |
| **`Tube Artillery / Mortar`** | `HE_Impact`, `HE_Airburst`, `Smoke`, `Direct_Self_Defense`, 2-round `Ranging`, `isPositionCalibrated` | M109A2 / M106 | 2S1 Gvozdika / 2S3 |
| **`MLRS`** (Rocket Artillery) | Uncalibrated area `FFE`, `ArtilleryShockPenalty` in open terrain | LARS-2 / M270 | BM-21 Grad |
| **`SHORAD / Area SAM`** | Low-altitude vs. high-altitude air defense envelopes across ground/air theater | Gepard / Roland | ZSU-23-4 / Osa-AKM |
| **`Helicopter`** | Ground-edge ingress/egress, `< 30% HP` `ForcedLanding` & `50%` field repair recovery, transport, FOB turnaround | AH-1F Cobra / UH-1D | Mi-24V Hind / Mi-8 |
| **`Fixed-Wing`** | 2× linear airspace, `low`/`high` `FlightAltitude` bot choice, `Afterburner` dogfight fuel burn, 3-part turnaround | F-4F / A-10A | MiG-23ML / Su-25 |
| **`Logistics`** (`FOB` & `SupplyVehicle`) | Immobile `FOB` (artillery-resistant, infinite supply) + empty-on-entry `SupplyVehicle` (`rearm`/`repair`/`WIA` healing) | NATO FOB + HEMTT | Pact FOB + Ural-4320 |

---

## 2. Zero-Adaptation-Cost Bot Interface (`Context-In, Action-Out`)

To allow hand-written deterministic FSM / utility bots in Stage 2 to be replaced cleanly by discriminative or generative AI decision models in Stage 3 with **zero adaptation cost**, unit decision-making is strictly separated from deterministic physical execution:

```ts
export interface UnitTacticalContext {
  self: {
    id: string;
    pos: Vec;
    heading: number;
    moraleTier: MoraleTier;
    suppression: number;
    hpRatio: number;
    wiaCount: number;
    kiaCount: number;
    ammoRatio: number;
    inBuilding?: { id: string; floor: number };
    order: Order; // Higher-level commander anchor & tactical posture
  };
  environment: {
    currentTerrain: TerrainId;
    inCover: boolean;
    nearbyCoverCandidates: Vec[];      // Nearby treeline, building, or defilade positions
    incomingArtilleryWarning: boolean; // Inside observed/predicted indirect fire zone
  };
  threatsAndTargets: {
    id: string;
    pos: Vec;
    detection: DetectionLevel;         // "contact" | "visual"
    ownPerception: "none" | "contact" | "visual"; // Determines 3-tier direct-fire accuracy
    canPenetrateThem: boolean;
    canTheyPenetrateMe: boolean;
  }[];
}

export type TacticalAction =
  | { kind: "hold_and_engage"; targetId?: string }
  | { kind: "move_to"; dest: Vec; useRoads: boolean }
  | { kind: "seek_local_cover"; coverPos: Vec }
  | { kind: "enter_building"; buildingId: string; floor: number }
  | { kind: "change_floor"; targetFloor: number }
  | { kind: "pop_smoke_and_retreat"; retreatPos: Vec }
  | { kind: "shoot_and_scoot"; displacePos: Vec }
  | { kind: "request_support"; request: SupportRequest }
  | { kind: "withdraw_off_map" };

export type UnitBrainFn = (ctx: UnitTacticalContext) => TacticalAction;
```

### Design Guarantees
1. **Deterministic Action Executors**: Every `TacticalAction` variant maps to a self-contained, deterministic physical execution routine (`executeAction(unit, action)` covering pathing, floor transitions, smoke deployment, firing, and shoot-and-scoot displacement).
2. **State Snapshot Packaging**: `UnitTacticalContext` packages all relevant local perception, terrain/building context, and threat assessments; Stage 2 FSM rules simply extract needed fields from `ctx`, while Stage 3 AI decision models consume the exact same `UnitTacticalContext` and return `TacticalAction`.

---

## 3. Request–Broker–Responder Support Network (`Tactical Support Broker`)

Rather than requiring the player or company commander to micromanage support units directly, support assets operate through a **one-way, prioritized ticket-dispatch loop** (`Request -> Broker -> Autonomous Responder`), designed to scale later into broader inter-unit requests (e.g., infantry requesting transport pickup or armor direct-fire support).

```ts
export type SupportRequestKind =
  | "artillery_he"      // Indirect HE fire (Broker/battery decides Impact vs. Airburst)
  | "artillery_smoke"   // Indirect smoke screen for LoS blocking
  | "air_strike"        // Fixed-wing or attack helicopter CAS request
  | "resupply_repairs"  // Field ammo resupply, vehicle repair, or WIA medical aid
  | "transport_pickup"  // Reserved: infantry requesting APC/IFV/Helo lift
  | "armor_support";    // Reserved: infantry requesting direct-fire armor assistance

export interface SupportRequest {
  id: string;
  requesterId: string;
  kind: SupportRequestKind;
  targetPos: Vec;
  urgency: number;          // 0..100 derived from requester suppression, casualties, and threat
  hasObserverSight: boolean;
  createdAt: number;
  ttl: number;
}
```

### Three-Stage Dispatch Loop
1. **Frontline Requester**: Combat units evaluate `UnitTacticalContext` and emit `SupportRequest` tickets when needed (e.g., pinned by impenetrable armor $\rightarrow$ `artillery_smoke` or `air_strike`; out of combat with depleted ammo or `WIA` losses $\rightarrow$ `resupply_repairs`).
2. **Virtual Scheduler (`SupportBroker`)**: Maintains the active `SupportRequest` queue and allocates tickets by `urgency`, proximity/range, ammo/supply state, and air/counter-battery threat (implemented as deterministic priority scheduling in Stage 2, replaceable by an AI coordinator in Stage 3).
3. **Autonomous Support Responder**: Support units run high-autonomy self-directed loops—accepting assigned tickets, executing missions (e.g., 2-round `Ranging` + `FFE`, empty-to-FOB supply shuttle runs), and autonomously protecting themselves (displacing to preserve or trade off `isPositionCalibrated`, avoiding enemy LoS, or aborting air sorties under severe stress).
