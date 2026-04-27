import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

type AvailabilityLike = {
  day?: unknown;
  slots?: unknown;
};

export function HasAtLeastOneSlot(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'hasAtLeastOneSlot',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (!Array.isArray(value)) {
            return false;
          }

          return value.some((item) => {
            const availabilityItem = item as AvailabilityLike;
            return (
              Array.isArray(availabilityItem?.slots) &&
              availabilityItem.slots.some((slot) => typeof slot === 'string')
            );
          });
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must include at least one selected slot`;
        },
      },
    });
  };
}
