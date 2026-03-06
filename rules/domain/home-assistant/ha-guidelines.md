# Home Assistant Guidelines

## Integration Development

- Prefer native integrations over custom components when available
- Document all custom components with clear installation instructions
- Include version compatibility information

## Automation Rules

- Keep automations simple and focused on single tasks
- Use meaningful entity and automation names
- Include comments in complex YAML configurations

## Security

- Never hardcode credentials in configuration files
- Use secrets.yaml for sensitive information
- Implement proper authentication for external access

## Performance

- Optimize database queries for history and recorder
- Limit polling intervals for resource-intensive integrations
- Use event-driven patterns over polling when possible
