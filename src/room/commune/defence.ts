import {
    CombatRequestKeys,
    customColors,
    defaultDataDecay,
    impassibleStructureTypes,
    impassibleStructureTypesSet,
    ourImpassibleStructuresSet,
    PlayerMemoryKeys,
    Result,
    roomDimensions,
    RoomMemoryKeys,
    safemodeTargets,
} from 'international/constants'
import { PlayerManager } from 'international/players'
import { simpleAllies } from 'international/simpleAllies/simpleAllies'
import { StatsManager } from 'international/stats'
import {
  findObjectWithID,
  findWeightedRangeFromExit,
  getRange,
  isAlly,
  isXYInBorder,
  randomIntRange,
  randomRange,
  randomTick,
} from 'utils/utils'
import { packCoord } from 'other/codec'
import { CommuneManager } from './commune'
import { CollectiveManager } from 'international/collective'
import { roomNameUtils } from 'room/roomNameUtils'
import { RampartPlans } from 'room/construction/rampartPlans'
import { customLog, LogTypes } from 'utils/logging'

export class DefenceManager {
  communeManager: CommuneManager

  constructor(communeManager: CommuneManager) {
    this.communeManager = communeManager
  }

  run() {
    if (!this.communeManager.room.roomManager.notMyCreeps.enemy.length) {
      this.considerRampartsPublic()
      return
    }

    // There are at least enemy creeps

    this.makeRampartsPrivate()
    this.advancedActivateSafeMode()

    if (!this.communeManager.room.roomManager.enemyAttackers.length) return

    // There are at least enemyAttackers

    this.assignDefenceTargets()
  }

  private shouldSafeMode() {
    const { room } = this.communeManager
    const { controller } = room

    // Conditions check

    if (controller.safeModeCooldown) return false
    if (!controller.safeModeAvailable) return false
    if (controller.upgradeBlocked) return false
    // We can't use safemode when the downgrade timer is too low
    if (controller.ticksToDowngrade <= CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD) return false
    // If another room is safemoded, make sure that we are a higher level
    if (
      CollectiveManager.safemodedCommuneName &&
      Game.rooms[CollectiveManager.safemodedCommuneName].controller.level >=
        this.communeManager.room.controller.level
    )
      return false

    // Filter attackers that are not invaders. If there are none, stop

    const nonInvaderAttackers = room.roomManager.enemyAttackers.filter(
      enemyCreep => !enemyCreep.isOnExit && enemyCreep.owner.username !== 'Invader',
    )
    if (!nonInvaderAttackers.length) return false

    if (!this.isControllerSafe()) return true
    if (!this.isBaseSafe()) return true

    return false
  }

  private isSafe() {}

  private isBaseSafe() {
    const { room } = this.communeManager

    const anchor = room.roomManager.anchor
    if (!anchor) {
      throw Error('no anchor')
    }

    const terrain = Game.map.getRoomTerrain(room.name)
    const rampartPlans = this.communeManager.room.roomManager.rampartPlans
    const enemyCoord = roomNameUtils.floodFillFor(room.name, [anchor], coord => {
      // Ignore terrain that protects us
      if (terrain.get(coord.x, coord.y) === TERRAIN_MASK_WALL) return false

      const planData = rampartPlans.getXY(coord.x, coord.y)
      if (planData) {
        // Filter out non-mincut ramparts
        if (planData.buildForNuke || planData.coversStructure || planData.buildForThreat)
          return true
        // Don't flood past mincut ramparts
        return false
      }

      // See if there is an enemy creep
      const enemyCreepID = room.roomManager.enemyCreepPositions[packCoord(coord)]
      if (!enemyCreepID) return true

      const enemyCreep = findObjectWithID(enemyCreepID)
      if (isAlly(enemyCreep.owner.username)) return true
      // If it can deal damage, safemode
      if (
        enemyCreep.combatStrength.ranged > 0 ||
        enemyCreep.combatStrength.melee > 0 ||
        enemyCreep.combatStrength.dismantle > 0
      )
        return Result.stop

      return true
    })

    // If there is an enemy inside our base, we want to safemode
    return !enemyCoord
  }

  /**
   * Identify claim creeps trying to downgrade the controller, safemode just before
   */
  private isControllerSafe() {
    const { room } = this.communeManager
    const terrain = Game.map.getRoomTerrain(room.name)
    const enemyCoord = roomNameUtils.floodFillFor(
      room.name,
      [room.controller.pos],
      (coord, packedCoord, depth) => {
        // See if we should even consider the coord

        // Ignore terrain that protects us
        if (terrain.get(coord.x, coord.y) === TERRAIN_MASK_WALL) return false

        // Don't go out of range 2 from controller
        if (depth > 2) return false

        // Ignore structures that protect us
        if (room.coordHasStructureTypes(coord, ourImpassibleStructuresSet)) return false

        // Past this point we should always add this coord to the next generation

        // See if there is an enemy creep
        const enemyCreepID = room.roomManager.enemyCreepPositions[packCoord(coord)]
        if (!enemyCreepID) return true

        const enemyCreep = findObjectWithID(enemyCreepID)
        if (isAlly(enemyCreep.owner.username)) return true
        // We only need to protect our controller from claim creeps
        if (!enemyCreep.parts.claim) return true

        // We identified an enemy claimed near our controller!
        return Result.stop
      },
    )

    // If there is an enemy claimer, we want to safemode
    return !enemyCoord
  }

  private advancedActivateSafeMode() {
    if (!this.shouldSafeMode()) return

    // If another room is safemoded and we determined it to be okay: unclaim it so we can safemode
    if (CollectiveManager.safemodedCommuneName) {
      const safemodedRoom = Game.rooms[CollectiveManager.safemodedCommuneName]
      safemodedRoom.controller.unclaim()
      // Add a return if we can't unclaim and safemode on the same tick
    }

    if (this.communeManager.room.controller.activateSafeMode() !== OK) return

    // Safemode was probably activated

    // Record that we safemoded so other communes know
    CollectiveManager.safemodedCommuneName = this.communeManager.room.name
  }

  private considerRampartsPublic() {
    if (!global.settings.publicRamparts) return

    const { room } = this.communeManager
    const roomMemory = Memory.rooms[room.name]

    // Wait some pseudo-random time before publicizing ramparts
    if (
      roomMemory[RoomMemoryKeys.lastAttackedBy] !== undefined &&
      roomMemory[RoomMemoryKeys.lastAttackedBy] < randomIntRange(100, 150)
    )
      return

    // Publicize at most 10 ramparts per tick, to avoid too many intents

    let intents = 0

    for (const rampart of room.roomManager.structures.rampart) {
      if (intents >= 10) return

      // If the rampart is public

      if (rampart.isPublic) continue

      // Otherwise set the rampart to public, increase increment

      rampart.setPublic(true)
      intents += 1
    }
  }

  private makeRampartsPrivate() {
    for (const rampart of this.communeManager.room.roomManager.structures.rampart) {
      if (rampart.isPublic) rampart.setPublic(false)
    }
  }

  private assignDefenceTargets() {
    const { room } = this.communeManager

    // Sort by estimated percent health change

    const defenderEnemyTargetsByDamage = Array.from(
      room.defenderEnemyTargetsWithDefender.keys(),
    ).sort((a, b) => {
      const creepA = findObjectWithID(a)
      const creepB = findObjectWithID(b)

      return (
        creepA.hits / creepA.hitsMax -
        (creepA.hits + room.defenderEnemyTargetsWithDamage.get(a)) / creepA.hitsMax -
        (creepB.hits / creepB.hitsMax -
          (creepB.hits + room.defenderEnemyTargetsWithDamage.get(b)) / creepB.hitsMax)
      )
    })

    customLog('ENEMY TARGETS BY DAMAGE', defenderEnemyTargetsByDamage, {
      type: LogTypes.warning,
    })

    // Attack enemies in order of most net damage members can heal

    for (const enemyCreepID of defenderEnemyTargetsByDamage) {
      if (!room.attackingDefenderIDs.size) break

      const enemyCreep = findObjectWithID(enemyCreepID)

      for (const memberID of room.defenderEnemyTargetsWithDefender.get(enemyCreepID)) {
        if (!room.attackingDefenderIDs.has(memberID)) continue

        const member = Game.getObjectById(memberID)

        Game.creeps[member.name].combatTarget = enemyCreep

        room.attackingDefenderIDs.delete(memberID)
      }

      if (this.communeManager.towerAttackTarget) continue

      const damage = room.defenderEnemyTargetsWithDamage.get(enemyCreep.id)
      room.visual.text(damage.toString(), enemyCreep.pos.x, enemyCreep.pos.y - 0.25, {
        font: 0.3,
      })

      if (enemyCreep.owner.username === 'Invader') {
        if (damage <= 0) continue
      } else {
        const playerMemory =
          Memory.players[enemyCreep.owner.username] ||
          PlayerManager.initPlayer(enemyCreep.owner.username)
        const weight = playerMemory[PlayerMemoryKeys.rangeFromExitWeight]

        if (/* findWeightedRangeFromExit(enemyCreep.pos, weight) *  */ damage < enemyCreep.hits)
          continue
      }

      this.communeManager.towerAttackTarget = enemyCreep
    }
  }

  manageDefenceRequests() {
    const { room } = this.communeManager

    if (!room.towerInferiority) return

    const hasTowers = !!room.roomManager.structures.tower.length

    let onlyInvader = true
    let minDamage = 0
    let minMeleeHeal = 0
    let minRangedHeal = 0

    for (const enemyCreep of room.roomManager.enemyAttackers) {
      if (enemyCreep.owner.username === 'Invader') {
        // If we have towers, don't care about the invader
        if (hasTowers) continue
      } else onlyInvader = false

      minDamage += Math.max(enemyCreep.combatStrength.heal * 1.2, Math.ceil(enemyCreep.hits / 50))
      minMeleeHeal += enemyCreep.combatStrength.melee + enemyCreep.combatStrength.ranged
      minRangedHeal += enemyCreep.combatStrength.ranged
    }

    // If we have towers and it's only invaders, we don't need a defence request
    if (onlyInvader && hasTowers) return

    // There is tower inferiority, make a defend request

    room.createDefendCombatRequest({
      [CombatRequestKeys.minDamage]: minDamage,
      [CombatRequestKeys.minMeleeHeal]: minMeleeHeal,
      [CombatRequestKeys.minRangedHeal]: minRangedHeal,
      [CombatRequestKeys.quadQuota]: 1,
      [CombatRequestKeys.inactionTimerMax]: onlyInvader ? 1 : randomIntRange(2000, 3000),
    })

    if (!global.settings.allyCommunication) return

    simpleAllies.requestDefense({
      roomName: room.name,
      priority: 1,
    })
  }

  private findPresentThreat() {
    const { room } = this.communeManager

    if (!room.towerInferiority) return false

    const presentThreat: PresentThreat = {
      total: 0,
      byPlayers: {},
    }

    for (const enemyCreep of room.roomManager.enemyAttackers) {
      let creepThreat = 0

      creepThreat += enemyCreep.combatStrength.dismantle
      creepThreat += enemyCreep.combatStrength.melee * 1.2
      creepThreat += enemyCreep.combatStrength.ranged * 3.5

      creepThreat += enemyCreep.combatStrength.heal / enemyCreep.defenceStrength

      creepThreat = Math.floor(creepThreat)

      presentThreat.total += creepThreat

      const playerName = enemyCreep.owner.username
      if (playerName === 'Invader') continue

      const playerThreat = presentThreat.byPlayers[enemyCreep.owner.username]
      if (playerThreat) {
        presentThreat.byPlayers[playerName] = playerThreat + creepThreat
        continue
      }

      presentThreat.byPlayers[playerName] = creepThreat
    }

    return presentThreat
  }

  manageThreat() {
    const { room } = this.communeManager

    const presentThreat = this.findPresentThreat()
    const roomMemory = Memory.rooms[room.name]

    if (!presentThreat) {
      // Reduce attack threat over time
      if (roomMemory[RoomMemoryKeys.threatened] > 0)
        roomMemory[RoomMemoryKeys.threatened] *= defaultDataDecay

      if (roomMemory[RoomMemoryKeys.lastAttackedBy] !== undefined)
        roomMemory[RoomMemoryKeys.lastAttackedBy] += 1
      return
    }

    // There is a present threat

    roomMemory[RoomMemoryKeys.threatened] = Math.max(
      roomMemory[RoomMemoryKeys.threatened],
      presentThreat.total,
      PlayerManager.highestThreat / 3,
    )

    for (const playerName in presentThreat.byPlayers) {
      const threat = presentThreat.byPlayers[playerName]

      const player = Memory.players[playerName]
      if (!player) {
        PlayerManager.initPlayer(playerName)
      }

      player[PlayerMemoryKeys.offensiveThreat] = Math.max(
        threat,
        player[PlayerMemoryKeys.offensiveThreat],
      )
      player[PlayerMemoryKeys.hate] = Math.max(threat, player[PlayerMemoryKeys.hate])
      player[PlayerMemoryKeys.lastAttackedBy] = 0
    }

    roomMemory[RoomMemoryKeys.lastAttackedBy] = 0
    return
  }
}

interface PresentThreat {
    total: number
    byPlayers: {[playerName: string]: number}
}
