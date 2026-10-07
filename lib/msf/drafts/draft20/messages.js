/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.msf.draft20.MessageWriter');

goog.require('goog.asserts');
goog.require('shaka.config.MsfFilterType');
goog.require('shaka.msf.draft18.MessageTypeId');
goog.require('shaka.msf.draft18.MessageWriter');
goog.requireType('shaka.msf.Utils');


/**
 * Serializes draft-20 control messages.
 *
 * Draft-20 is draft-18 with one message body changed, so this extends the
 * draft-18 writer and overrides marshalFetch() alone. Everything else --
 * the var int type and 16-bit length framing, SETUP, SUBSCRIBE, the parameter
 * and namespace encodings -- is byte for byte what draft-18 writes.
 *
 * The message type IDs this player sends and reads are unchanged too, so there
 * is no draft-20 copy of the enum. Draft-20 does rename PUBLISH_BLOCKED to
 * PUBLISH_SKIPPED and reserve PUBLISH_OK (0x1E), but this player sends
 * neither, so the draft-18 names are the ones in use and renaming them here
 * would leave two enums to keep in step for no gain.
 *
 * Draft-22 changed the LOCATION_FILTER value alone, so it extends this class
 * and overrides locationFilterValue() and createNestedWriter().
 */
shaka.msf.draft20.MessageWriter = class
  extends shaka.msf.draft18.MessageWriter {
  /**
   * Draft-20 removed the Fetch Type field along with the Joining variants, and
   * moved the range out of the message and into the LOCATION_FILTER parameter,
   * leaving a body shaped exactly like SUBSCRIBE.
   *
   * The range asked for is the same one draft-18 puts in the message, so it
   * goes out as a filter rather than being dropped: an absent LOCATION_FILTER
   * means an unfiltered fetch of the whole track (draft-20 section 10.2.9),
   * which is a different request.
   *
   * @override
   */
  marshalFetch(msg) {
    const range = shaka.msf.draft18.MessageWriter.fetchRange(msg);
    if (range.end.group < range.start.group) {
      // Delta encoding cannot express it, and the range is invalid in every
      // draft of this family anyway.
      throw new Error(
          `FETCH end group ${range.end.group} precedes start group ` +
          `${range.start.group}`);
    }

    const params = (msg.params || []).concat([{
      type: BigInt(shaka.msf.draft18.MessageWriter.Parameter.LOCATION_FILTER),
      // With all four fields present the filter is absolute, and EndGroupDelta
      // is measured from StartGroup rather than from the Largest Object. A
      // shorter field list would be read as a filter relative to the live edge
      // instead (draft-20 section 5.1.2).
      value: this.locationFilterValue([
        range.start.group,
        range.start.object,
        range.end.group - range.start.group,
        range.end.object,
      ]),
    }]);

    return this.marshal(shaka.msf.draft18.MessageTypeId.FETCH, () => {
      this.writeVarInt(msg.requestId);
      this.writeNamespace(msg.namespace);
      this.writeString(msg.trackName);
      this.writeParameters(params);
    });
  }

  /**
   * Draft-20 removed the Joining FETCH. A subscriber joins at the current
   * Group with FILL_PARAMETERS instead: its LOCATION_FILTER, evaluated like a
   * FETCH's, selects the Groups to fill, and StartGroup alone is relative to
   * the Next Group, so 1 is the current one (draft-20 section 5.1.6). The
   * publisher delivers them on a fill fetch stream whose FETCH_HEADER carries
   * the SUBSCRIBE's Request ID.
   *
   * The value is a Parameter list of its own, counted and delta encoded like
   * the one around it.
   *
   * @override
   */
  fillCurrentGroupParam() {
    const inner = this.createNestedWriter();
    inner.writeParameters([{
      type: BigInt(shaka.msf.draft18.MessageWriter.Parameter.LOCATION_FILTER),
      value: this.locationFilterValue([BigInt(1)]),
    }]);
    return {
      type: BigInt(shaka.msf.draft18.MessageWriter.Parameter.FILL_PARAMETERS),
      value: inner.getBytes(),
    };
  }

  /**
   * Draft-20 has no Joining FETCH; fillCurrentGroupParam() is what joins.
   *
   * @override
   */
  marshalJoiningFetch(msg) {
    throw new Error('Draft-20 has no Joining FETCH');
  }

  /**
   * Draft-20 replaced the Filter Type with a field count: the parameter's
   * own length is what says which of the optional fields are present
   * (draft-20 section 5.1.2, "Location Filters"; the parameter itself is
   * 0x21 in section 10.2.9). The change log calls this "Restructure the
   * Location Filter to match the other filter parameters" (A.1, since
   * draft-19); the filter it spells is not new, only its encoding is.
   *
   *   0 bytes  no filter at all
   *   1 field  StartGroup, RELATIVE
   *   2 fields StartGroup and StartObject, absolute
   *   3 fields + EndGroupDelta
   *   4 fields + EndObject
   *
   * The two-field form is the same request draft-18 spells as AbsoluteStart,
   * so for that type only the encoding changes.
   *
   * The one-field form is not absolute. The draft reads it as "a relative
   * number of groups prior to the Next Group, hence the start Location is
   * {Largest Object.Group + 1 - StartGroup, 0}", and says outright that
   * "StartGroup=0 will start at the Next Group" -- the same filter draft-18
   * spells as the type 0x1 Next Group Start. StartGroup=1 is the current
   * group, which is what fillCurrentGroupParam() above already writes, so
   * the relative form is not new to this file either.
   *
   * Both forms go out through locationFilterValue(), so draft-22 inherits
   * this method and reframes the value as its own Filter Type -- a field
   * count by another name -- without a second copy of the choice.
   *
   * Largest Object is deliberately not spelled here. Draft-20 can express it
   * as two zeroed fields, which it reads as the Next Object, but draft-22
   * numbers its Filter Types by field count, so two fields there are an
   * absolute {0, 0}: the start of the track rather than the live edge. It is
   * the publisher's default and the session asks for it by omitting the
   * parameter, which is the one spelling that means the same thing in every
   * draft of this family.
   *
   * @param {?shaka.msf.Utils.Location} startLocation
   * @param {shaka.config.MsfFilterType=} filterType
   * @return {shaka.msf.Utils.KeyValuePair}
   * @override
   */
  locationFilterParam(startLocation, filterType) {
    const FilterType = shaka.config.MsfFilterType;
    const type = BigInt(shaka.msf.draft18.MessageWriter.Parameter
        .LOCATION_FILTER);

    if (filterType == FilterType.NEXT_GROUP_START) {
      // Zero groups prior to the Next Group is the Next Group.
      return {type, value: this.locationFilterValue([BigInt(0)])};
    }

    // Refused outright rather than left to the assert below: a test build
    // turns a failed assert into a failed spec instead of a throw, and a
    // release build strips it and dereferences the null Location.
    if (filterType == FilterType.LARGEST_OBJECT) {
      throw new Error('Largest Object is sent as no filter at all');
    }

    goog.asserts.assert(
        startLocation, 'the absolute filter needs a start Location');
    return {
      type,
      value: this.locationFilterValue([
        startLocation.group,
        startLocation.object,
      ]),
    };
  }

  /**
   * The value of a LOCATION_FILTER holding these fields. In draft-20 that is
   * the fields alone: the parameter's length says how many there are.
   *
   * @param {!Array<bigint>} fields
   * @return {!Uint8Array}
   * @protected
   */
  locationFilterValue(fields) {
    return this.encodeVarIntField(fields);
  }

  /**
   * A writer of this draft for a parameter list nested inside another, as
   * FILL_PARAMETERS carries.
   *
   * @return {!shaka.msf.draft20.MessageWriter}
   * @protected
   */
  createNestedWriter() {
    return new shaka.msf.draft20.MessageWriter(this.getCodec());
  }
};
